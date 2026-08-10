---
title: "浅析Golang的内存管理(二)"
description: "学习Go的内存管理可以帮助我们编写更高性能的代码。 引言 在Go中由runtime来进行内存管理，通过内存分配器分配堆内…"
pubDate: "2021-06-28T10:19:09.449Z"
updatedDate: "2021-07-02T14:56:37.373Z"
tags: 
  - "Golang"
categories: 
  - "计算机"
---
> 学习Go的内存管理可以帮助我们编写更高性能的代码。

<img width="500" src="/images/浅析Golang的内存管理/0.png">

# 引言

在Go中由`runtime`来进行内存管理，通过内存分配器分配堆内存，垃圾处理器回收堆上不再使用的对象和内存空间。上一节讲了内存分配，这节讲垃圾回收。

现代编程语言中，垃圾收集有很多种算法，本文只讨论Go的垃圾收集器算法。

> 彻底理解Go runtime的垃圾回收是比较困难的，本文只是我个人学习过程中的总结，是站在我个人角度上进行的理解和梳理，深度不够。如果要更全面地学习Go的垃圾回收，推荐阅读本文最后列出的Reference和Go的源码。

# 垃圾回收

## 概述

虽然Go的GC(Garbage Collection)和用户goroutine可以并发执行，但是需要一段时间的STW(Stop the world)。当程序占用的内存达到一定阈值时，整个应用程序会暂停。垃圾收集器扫描已经分配的所有对象并回收不再使用的内存空间。

Go的GC的STW(Stop the world)影响程序性能是常听到的说法。因为一旦触发垃圾回收，在启动STW到停止STW的过程中，CPU不执行应用代码，全部用于执行GC代码，追求实时的应用无法接受长时间的STW。

垃圾收集器是Go的`runtime`改进最努力的部分，针对缩短STW时间做了很多迭代优化，目的都是为了提供程序实时性。

`src/runtime/mgc.go`的开头有这样一段注释。

> The GC runs concurrently with mutator threads, is type accurate (aka precise), allows multiple GC thread to run in parallel. It is a concurrent mark and sweep that uses a write barrier. It is non-generational and non-compacting. Allocation is done using size segregated per P allocation areas to minimize fragmentation while eliminating locks in the common case.

Go的GC是并发标记清理、使用写屏障、非紧缩、非分代的。

并发标记和用户代码同时执行让程序处于不稳定状态。用户代码在标记过程中，可能会修改已经扫描标记过的区域，或在标记过程中分配新对象。

垃圾回收最大的问题是，究竟什么时候启动垃圾回收？过早会浪费CPU资源，影响用户程序的性能；太晚会导致内存堆积。所以垃圾回收核心需要解决的问题有两个：一是抑制堆内存增长；二是充分利用CPU资源。

## 标记-清除算法

早期的Go用的是标记清除(mark-sweep)算法。

### GC流程

标记清除算法分成标记和清除两个阶段。

1. 标记阶段：从根对象出发，遍历并标记所有可达的对象，作上标记。
2. 清除阶段：清除未被标记的对象。

<img width="300" src="/images/浅析Golang的内存管理/8.gif">

### 缺点

1. 标记需要遍历整个heap。
2. 清除会产生heap碎片。
3. 标记前启动STW，清除后停止STW。在该过程中，应用程序都是暂停的，程序卡顿影响性能。

## 三色标记算法

为了缩短标记清除算法的STW时间，用三色标记算法优化。

三色标记算法将程序中的对象分为黑、灰、白三类。新创建的对象，默认都是白色。当完成全部扫描和标记后，剩余的非黑即白，黑色代表活跃对象，白色代表待回收对象，清理操作只需将白色对象的内存回收即可。

### GC流程

1. 从根节点遍历所有对象一次，标记为灰色，放入灰色标记表。
2. 遍历灰色标记表，将可达的对象，标记为灰色，放入灰色标记表。已经遍历过的灰色对象，标记为黑色，放入黑色标记表。
3. 重复上一步，直到灰色标记表为空。
4. 回收最后剩下的白色对象。

<img width="300" src="/images/浅析Golang的内存管理/9.gif">

### 缺点

整个GC过程，都需要STW。

如果不使用STW，GC中途创建或删除对象引用，下面两种情况一旦同时满足，就会导致对象被错误回收，这是致命的内存管理故障。

1. 如果黑色对象引用白色对象。因为黑色对象不会再被重复扫描，白色对象以及下游的对象会被GC清除。
2. 如果灰色对象引用白色对象，但是引用被清除。白色对象以及下游的对象会被GC清除。

如何在保证对象不丢失情况下，减少STW时间，提高GC效率？——只要破坏其中一个条件，这个问题就被解决。

### 强-弱三色不变式

提出强-弱三色不变式来破坏上面两种三色标记算法不能接受的情况。
只要满足下面两种不变式的任意一种，对象就不会被错误清理。

#### 强三色不变式

不允许黑色对象引用白色对象。—— 破坏了上述三色标记算法的缺点1。

#### 弱三色不变式

黑色对象可以引用白色对象，但是白色对象必须被灰色对象直接或间接(多级可达)引用。—— 破坏了上述三色标记算法的缺点2。

## 三色标记算法+屏障机制

何为屏障？我理解是一种hook机制，在GC过程中，某些条件（并发增加/修改/删除对象）满足的时候触发回调，以满足强三色不变式或弱三色不变式，从而保证三色标记算法的正确。

有两种屏障机制，来保证三色标记算法的正确。
- 插入屏障机制：对象被引用时，触发的机制。
- 删除屏障机制：对象被删除时，触发的机制。

### 插入屏障机制

当A对象新增引用B对象时，将B对象标记为灰色。——满足强三色不变式。

因为栈内存操作频繁，出于性能考虑，该策略只在堆内存的对象使用。即只在堆对象触发插入屏障机制。

对于栈内存的对象，当A对象新增引用B对象时，还是将B对象标记为白色。但是在GC回收白色对象之前，重新开启STW(防止插入)，扫描一次栈空间。

所以缺点是：在GC结束时需要STW来重新扫描栈。

### 删除屏障机制

当白色对象被删除引用时，将它标记为灰色。——满足弱三色不变式。

在栈内存和堆内存均触发删除屏障机制。

这个机制的目的是，当白色对象被删除引用时，如果有黑色对象引用白色对象，白色对象不会被错误回收。但如果白色对象真的被删除引用，在下一轮才会被清理。

所以缺点是：回收精度低。一个对象即使被真的删除了，也只能到下一轮被清理。

### 混合写屏障机制

为了避免重新扫描栈，进一步减少STW时间，在插入屏障机制和删除屏障机制的基础上，结合了优点，规避了缺点，引入混合写屏障机制。混合写屏障机制在GC期间通过监视内存中对象的修改，重新标色，来保障标记和用户代码并发执行。

只有堆对象触发混合写屏障机制。

具体规则是：
1. GC开始时，栈上从根节点开始扫描，将全部可达对象都标记为黑色。（避免GC结束时STW重新扫描栈，因为第一轮的可达对象始终是黑色的，而那些GC操作过程中由于并发操作导致的需要被清除的对象，在下一轮GC开始时不再被标记为黑色，所以在下一轮可以被清除。）
2. GC期间，创建在栈上的新对象，标记为黑色。
3. GC期间，被添加的对象，标记为灰色。（满足强三色不变式）
4. GC期间，被删除的对象，标记为灰色。（满足弱三色不变式）

> 三色标记算法+混合写屏障机制是目前Go runtime使用的垃圾回收策略。

## 何时触发GC

GC的触发条件有两种方式：手动触发和系统触发。

- 手动触发：通过应用程序调用`runtime.GC()`来触发检查调用GC。

- 系统触发：`runtime`自行维护，有两个地方会定时检查和GC。
1. 在分配内存时，在`mallocgc`函数里，会检查调用GC。
2. 后台监控线程sysmon定时会检查调用GC。

### 手动触发

应用程序主动调用`GC`函数，会阻塞当前运行的应用代码，直到GC完成。

函数位于`src\runtime\malloc.go`。

``` go
func GC() {
    // 获取GC的循环次数
    n := atomic.Load(&work.cycles)
    // 等待上一个循环的标记终止、标记和清除终止阶段完成
    gcWaitOnMark(n)
    // 触发新一轮的GC
    gcStart(gcTrigger{kind: gcTriggerCycle, n: n + 1})
    // 等待当前这轮的循环的标记终止、标记和清除终止阶段完成
    gcWaitOnMark(n + 1) 
    // 等待清理全部待处理的内存管理单元
    for atomic.Load(&work.cycles) == n+1 && sweepone() != ^uintptr(0) {
        sweep.nbgsweep++
        // 主动让出P
        Gosched()
    } 

    for atomic.Load(&work.cycles) == n+1 && atomic.Load(&mheap_.sweepers) != 0 {
        Gosched()
    }

    mp := acquirem()
    cycle := atomic.Load(&work.cycles)
    if cycle == n+1 || (gcphase == _GCmark && cycle == n+2) {
        // 完成本轮垃圾收集清理后，将该阶段的堆内存状态快照发布出来(heap profile)
        mProf_PostSweep()
    }
    releasem(mp)
}
```

可以看到，开始执行GC的是`gcStart()`函数。

``` go
func gcStart(trigger gcTrigger) {
    ...
    // 检查是否满足垃圾收集条件
    // 并清理已经被标记的内存单元
    for trigger.test() && sweepone() != ^uintptr(0) {
        sweep.nbgsweep++
    } 
    // 获取全局的startSema信号量(加锁)
    semacquire(&work.startSema) 
    // 再次检查是否满足垃圾收集条件
    if !trigger.test() {
        semrelease(&work.startSema)
        return
    }
    // 检查是不是手动调用了runtime.GC
    work.userForced = trigger.kind == gcTriggerCycle 

    semacquire(&gcsema)
    semacquire(&worldsema) 
    // 启动后台标记任务
    gcBgMarkStartWorkers()
    // 重置标记相关的状态
    systemstack(gcResetMarkState)

    // 对work结构体做初始化工作，设置垃圾收集需要的goroutine数量
    work.stwprocs, work.maxprocs = gomaxprocs, gomaxprocs
    if work.stwprocs > ncpu { 
        work.stwprocs = ncpu
    } 
    work.heap0 = atomic.Load64(&memstats.heap_live)
    work.pauseNS = 0
    work.mode = mode 
    // 记录开始时间
    now := nanotime()
    work.tSweepTerm = now
    work.pauseStart = now
    // 暂停程序STW
    systemstack(stopTheWorldWithSema) 
    // 在并发标记前，确保清理结束
    systemstack(func() {
        finishsweep_m()
    })
    // 清理sched.sudogcache以及sync.Pools
    clearpools()
    // GC次数+1
    work.cycles++
    // 在开始GC之前清理控制器的状态，标记新一轮GC已开始
    gcController.startCycle()
    work.heapGoal = memstats.next_gc 
    // 设置全局变量中的GC状态为_GCmark，然后启用写屏障
    setGCPhase(_GCmark)
    // 初始化后台扫描需要的状态
    gcBgMarkPrepare()
    // 扫描栈上、全局变量等根对象并将它们加入队列
    gcMarkRootPrepare() 
    // 标记所有tiny alloc内存块
    gcMarkTinyAllocs() 
    // 启用mutator assists(协助线程)
    atomic.Store(&gcBlackenEnabled, 1)
    // 记录标记开始的时间
    gcController.markStartTime = now
    mp = acquirem()
    // 启动程序，后台任务也会开始标记堆中的对象
    systemstack(func() {
        now = startTheWorldWithSema(trace.enabled)
        // 记录停止了多久, 和标记阶段开始的时间
        work.pauseNS += now - work.pauseStart
        work.tMark = now
    }) 
    semrelease(&worldsema)
    ...
}
```

如图所示，显示了`gcStart`过程中状态变化，以及STW停顿的时间段，写屏障启用的时间段。

<img width="500" src="/images/浅析Golang的内存管理/10.png">

`gcStart()`函数有一个`gcTrigger`参数，这是GC的触发条件。

``` go
// A gcTrigger is a predicate for starting a GC cycle. Specifically,
// it is an exit condition for the _GCoff phase.
type gcTrigger struct {
    kind gcTriggerKind
    now  int64  // gcTriggerTime: current time
    n    uint32 // gcTriggerCycle: cycle number to start
}
```

`gcTrigger`的`kind`有三种，`gcTriggerHeap`、`gcTriggerTime`、`gcTriggerCycle`。

- gcTriggerHeap：当前分配的内存达到一定阈值时触发，这个阈值在每次GC过后都会根据堆内存的增长情况和CPU占用率来调整。
- gcTriggerTime：自从上次GC后间隔时间达到`runtime.forcegcperiod`(120s，It normally doesn't change.)，将启动GC。通过sysmon监控线程调用`runtime.forcegchelper`检查。
- gcTriggerCycle：如果当前没有开启垃圾收集，则启动GC。

### 系统触发

#### 内存分配触发

从`src\runtime\malloc.go`的`mallocgc`函数可以看到，在为对象分配堆内存后，会检查GC的触发条件，如果满足条件，则开启`gcStart`。

``` go
func mallocgc(size uintptr, typ *_type, needzero bool) unsafe.Pointer { 
    ...
    dataSize := size
    // 获取mcache，用于处理微对象和小对象的分配
    c := gomcache()
    var x unsafe.Pointer
    // 表示对象是否包含指针，true表示对象里没有指针
    noscan := typ == nil || typ.ptrdata == 0
    // maxSmallSize=32768 32k
    if size <= maxSmallSize {
        // maxTinySize= 16 bytes 
        if noscan && size < maxTinySize {
            ...
        } else {
            ...
        }
        // 大于 32 Kb 的内存分配,通过 mheap 分配
    } else {
        ...
    } 
    ...
    // 在 GC 期间分配的新对象都会被标记成黑色
    if gcphase != _GCoff {
        gcmarknewobject(span, uintptr(x), size, scanSize)
    }
    ...
    // 检查GC触发条件
    if shouldhelpgc {
            if t := (gcTrigger{kind: gcTriggerHeap}); t.test() {
                    gcStart(t)
            }
    }
    return x
}
```

`gcStart`函数在上面已经分析过了。和手动调用的`GC()`中调用的`gcStart`函数是一样的。

在`mallocgc`中，通过调用`gcTrigger.test()`函数判断GC条件是否满足，满足则触发GC。上面已经提过`gcTrigger`的`kind`有三种，`gcTriggerHeap`、`gcTriggerTime`、`gcTriggerCycle`。只要满足其中一个`kind`就满足触发GC条件。

``` go 
func (t gcTrigger) test() bool {
    if !memstats.enablegc || panicking != 0 || gcphase != _GCoff {
        return false
    }
    switch t.kind {
    case gcTriggerHeap:
        // 当前分配的堆内存达到一定阈值(控制器计算的触发堆大小)
        return memstats.heap_live >= memstats.gc_trigger
    case gcTriggerTime:
        if gcpercent < 0 {
            return false
        }
        lastgc := int64(atomic.Load64(&memstats.last_gc_nanotime))
        // 自从上次GC后间隔时间已大于forcegcperiod
        return lastgc != 0 && t.now-lastgc > forcegcperiod
    case gcTriggerCycle:
        // 要求启动新一轮的GC
        return int32(t.n-work.cycles) > 0
    }
    return true
}
```

> heap_live的值会在内存分配的时候进行计算。
> gc_trigger的计算是通过`runtime.gcSetTriggerRatio()`函数。`gcSetTriggerRatio`函数会根据计算出来的`triggerRatio`来获取下次触发GC的堆大小是多少。`triggerRatio`是通过`gcControllerState.endCycle()`函数(`triggerRatio`每次GC后都会调整)。

#### 监控线程sysmon触发

在`runtime.main()`函数中，执行`init`前，会启动sysmon监控线程，执行后台监控任务。

代码在`src/runtime/proc.go`。

``` go
func main() {
    ...
    systemstack(func() {
    // 创建监控线程，该线程独立于调度器，不需要跟p关联即可运行
        newm(sysmon, nil, -1)
    })
    ...
}

func sysmon() {
    ...
  for {
        // 检查是否满足GC条件(GC间隔已超过gcTriggerTime)
        if t := (gcTrigger{kind: gcTriggerTime, now: now}); t.test() && atomic.Load(&forcegc.idle) != 0 {
            lock(&forcegc.lock)
            forcegc.idle = 0
            var list gList
            // 将forcegc.g这个goroutine添加到全局队列里等待被调度
            list.push(forcegc.g)
            injectglist(&list)
            unlock(&forcegc.lock)
        }
  }
  ...
}
```

`runtime`在启动时，会在一个初始化函数`init()`里启用一个`forcegchelper()`函数。

``` go
// start forcegc helper goroutine
func init() {
    go forcegchelper()
}

// 大部分时候陷入休眠，会被sysmon在满足GC条件时唤醒
func forcegchelper() {
    forcegc.g = getg() // 指定forcegc的goroutine
    lockInit(&forcegc.lock, lockRankForcegc)
    for {
        lock(&forcegc.lock)
        if forcegc.idle != 0 {
            throw("forcegc: phase error")
        }
        // 将forcegc设置为空闲状态，并进入休眠
        atomic.Store(&forcegc.idle, 1)
        // 为了减少系统资源占用，主动让自己陷入休眠，等待唤醒
        // 由sysmon监控线程根据条件来恢复这个gc goroutine
        goparkunlock(&forcegc.lock, waitReasonForceGCIdle, traceEvGoBlock, 1)
        if debug.gctrace > 0 {
            println("GC forced")
        }
        // 当forcegc.g被唤醒时，开始从此处进行调度完全并发
        gcStart(gcTrigger{kind: gcTriggerTime, now: nanotime()})
    }
}
```

> 我是这么理解的，`forcegc`是一个全局变量，所以`forcegchelper`可以由sysmon监控线程。在sysmon监控中，如果GC满足条件，会设置`forcegc.idle = 0`，一旦`forcegc.g`被唤醒，`forcegchelper`就会执行`gcStart`。

## 调节GC参数

Go的GC算法是固定的，用户无法去配置采用什么算法。GC相关的配置参数只有`GOGC`，用来表示触发GC的条件。

`src\runtime\mgc.go`的开头有这样一段注释。

> Next GC is after we've allocated an extra amount of memory proportional to the amount already in use. The proportion is controlled by GOGC environment variable(100 by default). If GOGC=100 and we're using 4M, we'll GC again when we get to 8M(this mark is tracked in next_gc variable). This keeps the GC cost in linear proportion to the allocation cost. Adjusting GOGC just changes the linear constant (and also the amount of extra memory used).

下次GC的时机通过环境变量`GOGC`来控制，默认是100，即增长100%的堆内存才会触发GC。如果当前使用了4M内存，那么下次GC将会在内存达到8M的时候。设置`GOGC=off`将完全禁用GC。

也可以通过`src/runtime/debug`中的`func SetGCPercent(percent int) int`函数设置，设置负数将完全禁用GC。

增大GOGC，虽然可以降低GC频率，但是会增加触发GC的堆大小，可能会导致OOM，需要根据实际情况调节。

## 如何观察GC

可以通过不同的方法来观察GC。

### GODEBUG=gctrace=1

将`GODEBUG`设置为`gctrace=1`。两种方式：

- `export GODEBUG=gctrace=1`
- `GODEBUG=gctrace=1 ./main`

```
gc # @#s #%: #+#+# ms clock, #+#/#/#+# ms cpu, #->#-># MB, # MB goal, # P
where the fields are as follows:
    gc #        the GC number, incremented at each GC
    @#s         time in seconds since program start
    #%          percentage of time spent in GC since program start
    #+...+#     wall-clock/CPU times for the phases of the GC
    #->#-># MB  heap size at GC start, at GC end, and live heap
    # MB goal   goal heap size
    # P         number of processors used
```

```
$ GODEBUG=gctrace=1 ./main
...
// gc 3: 第三个gc周期
// @0.002s: 程序开始后的0.002s
// 3%: 该GC周期中的CPU使用率
// 0.031+0.059+0.002 ms clock: 标记开始时STW所花的时间 + 标记过程中并发标记所花的时间 + 标记终止时STW所花的时间。总和是wall clock(实际的时间)。
// 0.12+0.040/0.024/0+0.009 ms cpu: 标记开始时STW所花的时间 + 标记过程中标记辅助所花的时间/标记过程中并发标记所花的时间/标记过程中GC空闲的时间 + 标记终止时STW所花的时间。总和是cpu time。
// 4->4->0 MB: 标记开始时堆大小的实际值/标记结束时堆大小的实际值/标记结束时标记为存活的堆大小
// 5 MB goal: 标记结束时堆的大小的目标值
// 4 P: 使用的P的数量
gc 3 @0.002s 3%: 0.031+0.059+0.002 ms clock, 0.12+0.040/0.024/0+0.009 ms cpu, 4->4->0 MB, 5 MB goal, 4 P

// scvg: runtime向操作系统申请内存产生的垃圾回收，向操作系统归还多余的内存
// 向操作系统归还了0MB内存
scvg: 0 MB released
// inuse: 1 已经分配给用户代码、正在使用的总内存大小(MB)
// idle: 62 空闲以及等待归还给操作系统的总内存大小(MB)
// sys: 63 通知操作系统中保留的内存大小(MB)
// released: 58 已经归还给操作系统的内存大小(MB)
// consumed: 5 (MB) 已经从操作系统中申请的内存大小(MB)
scvg: inuse: 1, idle: 62, sys: 63, released: 58, consumed: 5 (MB)
...
```

### go tool trace

从标准库导入`runtime/trace`，并添加几行模板代码。

``` go
package main
import (    
    "os"
    "runtime/trace"
)

func main() {
    f, err := os.Create("trace.out")    
  if err != nil {
        panic(err)
  } 
  defer f.Close()
  err = trace.Start(f)
  if err != nil {
        panic(err)
  } 
  defer trace.Stop()  
  // Your program here
}
```

运行程序会在`trace.out`文件中写入事件数据。 然后运行`go tool trace trace.out`，将解析跟踪文件，该命令将启动服务器，并使用跟踪数据来响应可视化操作。

## 内存泄露的情况

C/C++这种没有原生GC的语言，如果程序员没有及时手动释放堆内存，可能会导致内存泄露最终OOM。Go虽然有GC，但是也可能发生内存泄露。Go程序的内存泄露是因为：预期的能很快被释放的内存由于附着在了长期存活的内存上或生命期意外地被延长，导致预计能够立即回收的内存而长时间得不到回收。举例说明三种情况。

- 情况1

``` go
var cache = map[interface{}]interface{}{}
func keepalloc1() {
    for i := 0; i < 10000; i++ {
        m := make([]byte, 1<<10)
        // 全局变量cache被引用，没有得到迅速释放
        cache[i] = m
    }
}
```

- 情况2

``` go
func keepalloc2() {
    for i := 0; i < 100000; i++ {
        // 不断产生新的goroutine，且不结束已经创建的goroutine并复用这部分内存
        go func() {
            select {}
        }()
    }
}
```

- 情况3

``` go
var ch = make(chan struct{})
func keepalloc3() {
    for i := 0; i < 100000; i++ {
        // 没有接收方，goroutine会一直阻塞
        // 该goroutine会被永久的休眠，整个goroutine及其执行栈都得不到释放
        go func() { ch <- struct{}{} }()
    }
}
```

通过`go tool trace`验证一下。

``` go
package main

import (
    "os"
    "runtime/trace"
)

func main() {
    f, _ := os.Create("trace.out")
    defer f.Close()
    trace.Start(f)
    defer trace.Stop()
    keepalloc1()
    keepalloc2()
    keepalloc3()
}
```

使用`go tool trace trace.out`命令得到下图。可以看到，运行过程中Heap持续增长，没有被回收，产生了内存泄漏。

<img width="1000" src="/images/浅析Golang的内存管理/11.png">

## Go的逃逸分析

Go的逃逸分析指的是编译器执行静态代码分析后，对内存管理进行的优化和简化，决定一个变量是分配到堆上还是栈上。通过逃逸分析，可以把不需要分配到堆上的变量分配到栈上，减轻分配堆内存的开销，同时也减少GC的压力，提高程序的性能。

> How do I know whether a variable is allocated on the heap or the stack?
From a correctness standpoint, you don't need to know. Each variable in Go exists as long as there are references to it. The storage location chosen by the implementation is irrelevant to the semantics of the language.
The storage location does have an effect on writing efficient programs. When possible, the Go compilers will allocate variables that are local to a function in that function's stack frame. However, if the compiler cannot prove that the variable is not referenced after the function returns, then the compiler must allocate the variable on the garbage-collected heap to avoid dangling pointer errors. Also, if a local variable is very large, it might make more sense to store it on the heap rather than the stack.

从官方的回答，可以看出Go逃逸分析基本的原则是：
- 如果一个函数返回的变量被外部引用，那么它就会发生逃逸，被分配到堆上。
- 如果函数的局部变量非常大，也可能被分配到堆上。

Go的new函数分配的内存不一定在堆上。即使用new申请到的内存，如果在退出函数后没有用了，就会被分配到栈上；即使是一个普通的变量，但是逃逸分析发现在退出函数之后还有其他地方在引用，就被分配到堆上。

举个栗子。

``` go
package main

import "fmt"

func test() *int {
    a := 1
    return &a
}
func main() {
    b := test()
    fmt.Println(*b)
}
```

```
$ go build -gcflags '-m -l' demo.go
# command-line-arguments
./demo.go:6:2: moved to heap: a
./demo.go:11:13: ... argument does not escape
./demo.go:11:14: *b escapes to heap
```

通过查看逃逸分析结果看出：
- `test`函数里的变量a逃逸了。因为`test`函数返回了a的地址。
- main函数里的`b`也逃逸了。因为`func Println(a ...interface{})`参数为`interface{}`类型，编译期间不能确定其参数的类型，也会发生逃逸。

> 这个栗子只是逃逸分析里最简单的情况。

## GC调优

### 调优思想

并非所有程序都需要关注GC，只有以下两种情况需要对GC进行性能调优。

- 对停顿敏感：用户代码需要实时性，无法接受GC长时间STW。
- 对CPU资源消耗敏感：对于频繁分配内存的应用，影响用户代码对CPU的利用率。

所以，针对这两点，除了降低GC频率(通过增大GOGC的值)，GC调优的核心就是：

- 控制：优化内存的申请速度
- 减少：尽可能少申请内存，比如初始化至合适的大小，尽量使用引用传递
- 复用：复用已申请的内存

### 一些优化

1. 对于频繁分配内存的对象，可以使用`sync.Pool`进行内存复用，减少分配内存频次，从而降低GC频率。
2. 控制内存分配的速度，限制goroutine的数量，从而提高赋值器对CPU的利用率。
3. `slice`和`map`等结构提前分配足够的内存，降低扩容时多余的拷贝。
4. 不逃逸的对象分配在栈上，当函数返回时就回收了资源，不需要GC标记清除，减少GC频率。
5. 避免`string`与`[]byte`转换，两者发生转换的时候，底层数据结结构会进行复制，因此导致GC效率会变低（有优化的方法）。
6. 少量使用`+`连接string。因为string是一个只读类型，Go不能直接修改string类似变量的内存空间，针对它的每一个操作都会创建一个新的string。如果是大量小文本拼接，用`strings.Join`；如果是大量大文本拼接，用`bytes.Buffer`。

> GC优化点不只这些，等我研究一下有时间再细讲。

# Reference

[1]. https://draveness.me/golang/
[2]. https://www.luozhiyun.com/archives/475
[3]. https://golang.design/under-the-hood/zh-cn/part2runtime/ch08gc/pacing/
[4]. https://www.kancloud.cn/aceld/golang/1958308
[5]. https://pkg.go.dev/runtime?utm_source=godoc
[6]. https://www.bookstack.cn/read/qcrao-Go-Questions/GC-GC.md
[7]. https://golang.org/doc/faq#stack_or_heap
