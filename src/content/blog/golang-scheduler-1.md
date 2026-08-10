---
title: "浅析Golang的调度器(一)"
description: "进程/线程/协程/Goroutine 进程(Process) 在说进程是什么之前，先考虑一下为什么需要进程？ 早期批处理…"
pubDate: "2021-06-19T10:33:38.021Z"
updatedDate: "2021-06-29T02:59:05.300Z"
tags: 
  - "Golang"
categories: 
  - "计算机"
---
# 进程/线程/协程/Goroutine

## 进程(Process)

在说进程是什么之前，先考虑一下为什么需要进程？
早期批处理系统只能一次处理一个任务，多道程序设计的引入，内存中可以同时存放多个程序，在操作系统的管理下，可以并发(同一时间间隔)处理多个任务。所以需要引入进程，合理地隔离资源、运行环境，提升资源利用率。

所以，进程是操作系统进行资源分配和调度的基本单位，作为程序独立运行的载体保障程序正常执行，使得资源利用率大幅提升。

程序最初只是一个文本文件，被编译或解释成二进制，载入到内存后成为一个或多个正在运行的进程，它不仅需要告诉CPU应该执行什么二进制指令，还需要内存和各种操作系统资源才能运行。所以进程也可以理解为：加载到内存中的程序 + 程序运行所需的所有资源（操作系统分配和管理这些资源）。

进程作为运行中的程序在操作系统中的一个具象化的表现，在内存中的典型存储空间布局如图所示。每个进程都拥有如图的存储空间，独立不共享。所以从一个进程切换到另一个进程需要一些时间来保存和加载寄存器、内存映射和其他资源。

<img width="400" src="/images/浅析Golang的调度器/1.png">

- text: 代码区。程序代码编译后的能被CPU执行的机器指令。一旦加载后只读，大小不会再变化。
- initialized data: 程序初始化的变量，全局变量和静态变量。一旦加载后只读，大小不会再变化。
- uninitialized data(bss): 程序没有初始化的全局变量和静态变量，会被初始化为0或空指针。
- stack: 函数调用栈。保存函数的局部变量、向被调用函数传递参数、返回函数的返回值、函数的返回地址。
- heap: 堆。程序运行时动态分配的内存(例如调用malloc)，大小随程序的运行而变化。从堆上分配的内存用完后必须归还给堆，否则内存分配器可能会反复向操作系统申请扩展堆的大小，最后内存不足导致内存泄露。

> c/c++必须小心处理堆的分配和释放。但是go的runtime有垃圾处理器进行垃圾回收。
> c/c++绝对不要返回函数局部变量的地址，因为同一地址的栈内存会被其它函数重用。但是go的编译器发现程序返回了某个局部变量的地址，编译器会把这个变量放到堆上去。

## 线程(Thread)

线程是进程中的执行单元。简单地说，线程是由内核负责调度且拥有自己私有的一组寄存器值和栈的执行流。

如图所示，例如一个程序要输出2次print，可以用一个执行流依次执行；也可以创建2个执行流，每个执行流执行一次print。如果有2个cpu，就可以实现单进程中利用2个执行流并行执行print。所以线程是操作系统独立调度的最小单位。操作系统对线程的调度可以简单地理解为内核对不同线程所使用的寄存器和栈的切换。

<img width="400" src="/images/浅析Golang的调度器/2.png">

每个线程都有自己的stack，但是进程中的所有线程都将共享heap和其它资源。所以同一进程的线程之间的通信成本相对较低，但同时增加了解决临界资源的锁问题。

相比于进程，线程最大的好处是同一进程的线程之间切换上下文开销较小。

## 协程(Coroutine)

一些现代编程语言中，引入了协程的概念。为什么引入协程？

虽然多线程/多进程解决了阻塞带来的CPU浪费，可以并发执行多个任务。但是引入新的问题，一是进程/线程数量越多，CPU在执行程序和切换进程/线程中来回，切换成本越大；二是多线程需要解决同步和竞争(锁、资源竞争冲突等)问题；三是进程/线程都是高内存(虚拟内存)占用，进程的量级在GB，线程的量级在MB。

所以协程的产生是为了追求更好地利用CPU和内存。把线程一分为二：内核空间的线程+用户空间的协程。具体语言会做相应的绑定和调度策略，比如本文要讲的go语言的GMP模型的协程调度器。

所以，协程是用户态的概念。线程是由操作系统在内核态调度的，协程则是由应用程序在用户态调度的。

多个协程可以运行在一个线程中。相比于线程，有两个优势：
- 一个协程只需要量级KB的栈内存，而线程的量级是MB。
- 由于协程之间的切换发生在用户态，没有系统调用，切换效率远高于线程（我理解是在子程序之间来回切换）。

> 只有内核对线程的调度才能利用多核CPU让程序并行执行，所以一个线程中的多个协程是无法并行执行的。
> 协程非常适合用于并发执行IO密集型任务，但不适合计算密集任务。因为计算密集型任务需要连续执行指令，切换会损失CPU资源；IO密集型任务，任务阻塞在IO等待，切换不会损失CPU资源。

## Goroutine

不能简单地将go语言中的goroutine理解为协程。因为多个goroutine在运行时创建多个线程来执行并发任务。goroutine在运行时可以被分派到其它线程执行。goroutine更像是线程和协程的结合，可以最大限度利用多核CPU。

相比于线程，goroutine的优势在于轻量，体现在两个方面：
- goroutine的创建和切换在用户态就能完成，无需进入内核态。开销远小于需要进入内核态创建和切换的线程。
- 线程的栈内存空间一旦创建和初始化完成后其大小就不能再变化，而且这个栈内存空间较大；而goroutine启动时默认栈大小只有2KB，而且可以由`runtime`自动伸缩，既没有栈溢出风险，也不会造成栈内存空间浪费。

> 线程的调度是抢占式的，由内核决定。但是goroutine的调度是用户态决定的，在go1.14之前是非抢占式的，在go1.14开始是抢占式的。

用一个example可以看出go1.14前后版本的区别。

``` go
package main

import (
  "fmt"
  "runtime"
  "time"
)

func main() {
  runtime.GOMAXPROCS(1) // 限制CPU使用1核，否则无法区分结果
  var a [10]int
  for i := 0; i < 10; i++ {
    go func(i int) {
      for {
        a[i]++
      }
    }(i)
  }
  time.Sleep(time.Second)
  fmt.Println(a)
}
```

用go1.13编译器，该程序会死循环，永远无法退出。如图所示，可以看到CPU占用率持续在接近100%。
因为在go1.13中，goroutine调度器还是非抢占式的，除非遇到IO阻塞等情况，否则goroutine不会主动交出CPU的使用权。我们的示例是个计算密集型程序，main goroutine永远拿不到CPU的使用权，所以程序永远无法结束。

<img width="400" src="/images/浅析Golang的调度器/6.png">

用go1.14编译器，可以得到类似`[66722775 68857017 71320685 63615563 60855132 52515950 51764765 53227266 57977851 61729335]`的输出。
因为在go1.14中，goroutine调度器是抢占式的，goroutine占用CPU的时间是被限制的，只要main函数中的goroutine拿到CPU的使用权，就能结束程序。

# GMP模型

## GM模型的问题

在2012年go1.0版本之前，goroutine调度器是`GM`模型。G代表goroutine，M(thread)代表线程。如图所示，goroutine维护在全局队列，M想要执行、放回G都必须访问全局队列。因为M有多个，访问临界资源全局队列需要加锁保证互斥/同步。

`GM`模型有几个缺点：

1. 创建、销毁、调度G都需要M获取锁，锁竞争导致性能低下。
2. 当G需要创建子协程G'，为了继续执行G，需要把G'交给M'执行，导致程序的局部性很差(因为G和G'相关的)。
3. CPU在M之间的频繁切换导致较大的系统调用开销。

<img width="400" src="/images/浅析Golang的调度器/5.png">

## GMP模型的引入

针对`GM`模型的弊端，引入了`GMP`模型，它增加了`P`(processor)。`M`和`P`绑定，`P`中包含`G`的局部运行队列。

如图所示，可以看出，每个`M`都绑定了一个`P`，每个`P`都有一个私有的goroutine本地运行队列，`M`从本地和全局goroutine队列中获取goroutine并运行之。

<img width="400" src="/images/浅析Golang的调度器/4.png">

- 全局队列：存放等待运行的G。
- P的本地队列：也是存放等待运行的G。不超过256个。G新建子协程G'时，G'优先加到本地队列。如果队列满，则把本地队列的一半G移动到全局队列。
- P：所有P都在程序启动时创建，最多`GOMAXPROCS`(可配置) 个。
- M：M和P绑定，M通过P间接从本地队列获取G，P队列为空时候，M也会尝试从全局队列拿一批G放到P的本地队列，或者从其他P的本地队列偷取G放到自己的本地队列。M运行G，G执行完成后，M会从P获取下一个G，不断重复，直到主进程退出。

> P的数量由`GOMAXPROCS`决定，运行时候系统会根据这个数量创建P，这意味着同一时刻，只有`GOMAXPROCS`个goroutine在并行。
> M的最大数量由`runtime`的 `SetMaxThreads`函数设置。当一个M阻塞，P会创建新的M或切到另一个空闲的M。所以P和M的数量没有绝对关系。

## 为什么是M:N

go的调度器是基于GMP模型的。先说结论，GMP模型中，线程和协程的绑定是M:N关系。M个goroutine运行在N个线程之上，内核负责对这N个线程进行调度，这N个线程又负责对这M个goroutine进行调度。

<img width="400" src="/images/浅析Golang的调度器/3.png">

再说为什么是M:N关系？

- 如果绑定是N:1关系，N个协程绑定在一个1个线程上。优点是可以在用户态快速切换协程。缺点是1个进程的所有协程都绑定在1个线程上，无法利用多核CPU。一旦某个协程阻塞，线程也会阻塞，其它协程都无法执行。

- 如果绑定是1:1关系，1个协程绑定在1个线程上。可以利用多核，不存在N:1关系的缺点。但反而多了协程的创建和删除开销，且切换上下文慢。

- 绑定是M:N关系，M个协程绑定在N个线程上。解决了上面两种模型的缺点，能利用多核，也能快速切换协程。但瓶颈在于协程调度器的优化和调度算法。

所以，即使某个工作线程遇到goroutine阻塞，该线程的其它goroutine也能被`runtime`调度，转移到其它工作线程执行。

## GMP模型的数据结构

以下列举的结构体的定义位于Go源代码的`src/runtime/runtime2.go`。

### g

线程对goroutine的调度和内核对线程的调度，其原理是类似的，都是通过保存和修改CPU寄存器的值来实现切换线程/goroutine。

所以，为了实现对goroutine的调度，goroutine调度器引入`g`结构体来保存CPU寄存器的值和goroutine的所有信息。`g`的每一个实例对象代表一个goroutine。当goroutine被调离CPU时，调度器负责把CPU寄存器值保存在`g`对象的成员变量中；当goroutine被调度在CPU运行时，调度器负责把`g`对象的成员变量保存的寄存器值恢复到CPU寄存器中。

```
type g struct {
    stack       stack // 记录该goroutine使用的栈
    // 下面两个成员用于栈溢出检查，实现栈的自动伸缩，抢占调度也会用到stackguard0
    stackguard0 uintptr // offset known to liblink
    stackguard1 uintptr // offset known to liblink
    ......    
    m              *m // 此goroutine正在被哪个工作线程执行
    sched          gobuf // 保存调度信息，主要是几个寄存器的值
    ......
    schedlink      guintptr // 指向全局运行队列中的下一个g，所有位于全局运行队列中的g形成一个链表
    ......
    preempt        bool // 抢占调度标志，如果需要抢占调度，设置preempt为true
    ......
}
```

### schedt

可运行的`g`对象需要有存放在一个容器里，便于被工作线程调度并运行。调度器引入`schedt`结构体，用来保存`g`对象的运行队列(称之为goroutine全局运行队列)，也用来保存调度器自身的状态信息。

每个go程序中，只有一个`schedt`的实例对象，被定义成一个共享的全局变量。这样每个线程都可以访问`schedt`对象，以及获取`schedt`的goroutine全局运行队列。

```
type schedt struct {
    // accessed atomically. keep at top to ensure alignment on 32-bit systems.
    goidgen  uint64
    lastpoll uint64
    lock mutex
    // 由空闲的工作线程组成链表
    midle        muintptr // idle m's waiting for work
    // 空闲的工作线程的数量
    nmidle       int32    // number of idle m's waiting for work
    nmidlelocked int32    // number of locked m's waiting for work
    mnext        int64    // number of m's that have been created and next M ID
    // 最多只能创建maxmcount个工作线程
    maxmcount    int32    // maximum number of m's allowed (or die)
    nmsys        int32    // number of system m's not counted for deadlock
    nmfreed      int64    // cumulative number of freed m's
    ngsys uint32 // number of system goroutines; updated atomically
    // 由空闲的p结构体对象组成的链表
    pidle      puintptr // idle p's
    // 空闲的p结构体对象的数量
    npidle     uint32
    nmspinning uint32 // See "Worker thread parking/unparking" comment in proc.go.
    // goroutine全局运行队列
    runq     gQueue
    runqsize int32
    ......
    // gFree是所有已经退出的goroutine对应的g结构体对象组成的链表
    // 用于缓存g结构体对象，避免每次创建goroutine时都重新分配内存
    gFree struct {
        lock          mutex
        stack        gList // Gs with stacks
        noStack   gList // Gs without stacks
        n              int32
    }
    ......
}
```

### p

因为全局运行队列是临界资源，每个工作线程都可读，访问它需要加锁，影响调度器性能。所以调度器为每个工作线程引入`p`结构体来保存一个私有的goroutine局部运行队列，工作线程优先用局部运行队列获取goroutine进行调度，提高工作线程的并行性。

所以，每个工作线程都会和一个`p`对象关联。

```
type p struct {
    lock mutex
    status       uint32 // one of pidle/prunning/...
    link            puintptr
    schedtick   uint32     // incremented on every scheduler call
    syscalltick  uint32     // incremented on every system call
    sysmontick  sysmontick // last tick observed by sysmon
    m                muintptr   // back-link to associated m (nil if idle)
    ......

    // 本地goroutine运行队列
    runqhead uint32 // 队列头
    runqtail uint32 // 队列尾
    runq     [256]guintptr // 使用数组实现的循环队列
    runnext guintptr

    // Available G's (status == Gdead)
    gFree struct {
        gList
        n int32
    }
    ......
}
```

### m

调度器用`m`结构体保存工作线程的状态，包括工作线程的栈起始位置、当前正在运行的goroutine、是否空闲等，还通过指针维持`p`对象的绑定关系。每个工作线程和一个`m`对象对应。

所以，通过`m`对象，可以找到它正在运行的goroutine，也可以间接通过`p`对象找到局部运行队列。

```
type m struct {
    g0      *g // 用来记录工作线程使用的栈信息，在执行调度代码时需要使用这个栈。执行用户goroutine代码时，使用用户goroutine自己的栈，调度时会发生栈的切换
    tls           [6]uintptr // 通过TLS实现m结构体对象与工作线程之间的绑定
    mstartfn      func()
    curg          *g // 指向工作线程正在运行的goroutine的g结构体对象

    p             puintptr // 记录与当前工作线程绑定的p结构体对象
    nextp         puintptr
    oldp          puintptr

    // spinning状态：表示当前工作线程正在试图从其它工作线程的本地运行队列偷取goroutine
    spinning      bool // m is out of work and is actively looking for work
    blocked       bool // m is blocked on a note

    park          note // 没有goroutine需要运行时，工作线程睡眠在这个park成员上，其它线程通过这个park唤醒该工作线程
    alllink       *m // 记录所有工作线程的一个链表
    schedlink     muintptr

    thread        uintptr // 线程ID
    freelink      *m      // on sched.freem
    ......
}
```

工作线程执行的代码是如何找到属于自己的`m`对象的呢？答案是通过线程本地存储。每个工作线程拥有各自私有的`m`对象，在不同的工作线程中，使用相同的全局变量名来访问不同的`m`对象。

> 在gcc中，在定义全局变量时增加__thread，这样该变量就变成线程私有变量了。

在goroutine调度器中，每个工作线程在被创建后，线程本地存储机制就为该线程实现一个指向`m`对象的私有全局变量。这个工作线程的代码就可以使用该全局变量访问自己的`m`对象以及和`m`对象关联的`p`对象和`g`对象。

### stack

`stack`结构体用于记录goroutine使用的栈的起始和结束位置。

```
type stack struct {  
    lo uintptr    // 栈顶，指向内存低地址
    hi uintptr    // 栈底，指向内存高地址
}
```

### gobuf

`gobuf`结构体用于保存goroutine的调度信息，包括CPU的几个寄存器的值。

```
type gobuf struct {
    sp   uintptr  // 保存rsp寄存器的值
    pc   uintptr  // 保存rip寄存器的值
    g    guintptr // 记录当前这个gobuf对象属于哪个goroutine
    ctxt unsafe.Pointer

    // 保存系统调用的返回值，因为从系统调用返回之后如果p被其它工作线程抢占，
    // 则这个goroutine会被放入全局运行队列被其它工作线程调度，其它线程需要知道系统调用的返回值。
    ret  sys.Uintreg  
    lr   uintptr

    bp   uintptr // 保存rip寄存器的值
}
```

### 全局变量

一些重要的全局变量。

```
allgs     []*g // 保存所有的g
allm       *m // 所有的m构成的一个链表，包括下面的m0
allp       []*p // 保存所有的p，len(allp) == gomaxprocs
ncpu             int32 // 系统中cpu核的数量，程序启动时由runtime代码初始化
gomaxprocs int32  // p的最大值，默认等于ncpu，但可以通过GOMAXPROCS修改
sched      schedt // 调度器结构体对象，记录了调度器的工作状态
m0  m  // 代表进程的主线程
g0   g // m0的g0，也就是m0.g0 = &g0
```

这些全局变量会被初始化为0值(指针会被初始化为nil指针，切片初始化为nil切片，int被初始化为数字0，结构体的所有成员变量按其本类型初始化为其类型的0值)。所以程序刚启动时allgs，allm和allp都不包含任何g、m、p。

# 调度器

## 工作流程

goroutine调度器本质是按照一定的算法把大量的goroutine分配到少量的线程上利用CPU去运行，充分利用多核CPU并行。

工作流程简易地可以用下面伪代码描述。

```
for i := 0; i < N; i++ { // 创建N个线程执行schedule函数
     create_os_thread(schedule) // 创建一个线程执行schedule函数
}

// 定义一个线程私有全局变量，它是一个指向m对象的指针
// 真实的调度器中，不光是schedule函数需要访问m，其它很多地方也需要访问m，所以将其定义成私有全局变量。
ThreadLocal self *m

// schedule函数实现调度逻辑
func schedule() {
    // 创建和初始化m结构体对象，并赋值给私有全局变量self
    self = initm()  
    for { // 调度循环
          if (self.p.runqueue is empty) {
                 // 根据某种算法从全局运行队列中找出一个需要运行的goroutine
                 g := find_a_runnable_goroutine_from_global_runqueue()
           } else {
                 // 根据某种算法从私有的局部运行队列中找出一个需要运行的goroutine
                 g := find_a_runnable_goroutine_from_local_runqueue()
           }
          run_g(g) // CPU运行该goroutine，直到需要调度其它goroutine才返回
          save_status_of_g(g) // 保存goroutine的状态，主要是寄存器的值
     }
}
```

## 设计策略

1. 复用线程：避免频繁地创建、销毁线程。
- work stealing：当某个M无可运行的G时，从其他M绑定的P偷取G，而不是销毁线程。
- hand off：当某个M因为G进行系统调用阻塞时，M释放绑定的P，将P由其他空闲的M绑定并运行。
2. 利用并行：`GOMAXPROCS`设置P的数量，最多有`GOMAXPROCS`个线程分布在CPU上并行。
3. 抢占：不同于coroutine的非抢占式，从go1.14开始，goroutine的调度器是抢占式的，一个goroutine占用CPU的时间是被限制的。
4. 全局G队列：依然有全局G队列。但是只有在M执行work stealing从其他P偷不到G时，才从全局G队列获取。

> 下一篇会简单分析下Golang调度器的源码。

# Reference

[1].UNIX环境高级编程（第3版）https://book.douban.com/subject/25900403/
[2].https://www.backblaze.com/blog/whats-the-diff-programs-processes-and-threads/
[3].https://learnku.com/articles/41728
[4].https://mp.weixin.qq.com/mp/homepage?__biz=MzU1OTg5NDkzOA==&hid=1&sn=8fc2b63f53559bc0cee292ce629c4788&scene=1&devicetype=android-29&version=2800015d&lang=zh_CN&nettype=3gnet&ascene=7&session_us=gh_8b5b60477260&wx_header=1
