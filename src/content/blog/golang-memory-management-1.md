---
title: "浅析Golang的内存管理(一)"
description: "学习Go的内存管理可以帮助我们编写更高性能的代码。 引言 进程在内存中的存储空间，有两个大小随程序的运行而变化的区域：栈…"
pubDate: "2021-06-26T07:56:08.234Z"
updatedDate: "2021-07-27T02:40:13.914Z"
tags: 
  - "Golang"
categories: 
  - "计算机"
---
> 学习Go的内存管理可以帮助我们编写更高性能的代码。

# 引言

进程在内存中的存储空间，有两个大小随程序的运行而变化的区域：栈区(stack)和堆区(heap)。

- 栈区(stack)
1. 保存函数的局部变量、向被调用函数传递参数、返回函数的返回值、函数的返回地址。
2. 进程的每个线程有独立的stack。
3. 有大小限制(可修改)，开发者需要控制递归深度等，防止栈溢出。
4. 这部分内存由编译器进行管理。

- 堆区(heap)
1. 程序运行时动态分配的内存，保存全局变量、引用类型等。
2. 进程的多个线程共享heap。
3. 从堆上分配的内存用完后必须归还给堆，否则内存分配器可能会反复向操作系统申请扩展堆的大小，最后内存不足导致内存泄露。

所以，我们讨论内存管理，指的是堆内存管理。在C/C++中由开发者主动申请和释放(提供malloc、free等方法来管理内存)，涉及用户态和内核态切换；在Go中由`runtime`来进行内存管理，通过内存分配器分配和垃圾处理器(Garbage collection,GC)回收，从而避免频繁地向操作系统申请、释放内存，有效地提升程序的性能。

内存管理的流程简单可以描述是：程序通过内存分配器申请内存，内存分配器负责从堆中初始化相应的内存区域，再被内存收集器回收。

如果堆上有足够的空间满足程序的内存申请，内存分配器可以完成内存申请无需内核参与，否则将通过操作系统调用(brk)进行扩展堆内存。

如果让我们设计内存管理，如何保证高效稳定？
- 内存池：要减少用户态和内核态的频繁切换，就需要自己申请一块内存空间，将之分割成大小规则不同的内存块来供程序使用。
- GC：动态地垃圾回收，销毁无用的对象，释放内存来保证内存使用过程中节约。
- 锁：堆是被多线程共享的，一个办法是通过加锁保证同一时间只能有一个线程在申请；另一个办法是内存隔离，在Go中用的macache进行隔离。

# 内存分配

## TCMalloc

内存池的设计直接决定是否能尽可能减少内存碎片。这个由调用底层哪种内存分配算法决定。
Go的内存管理基于TCMalloc，但又有些差异。在Go中，局部缓存并不是分配给进程或者线程，而是分配给P(Processor)；Go的GC是stop the world，并不是对每个进程单独进行GC；Go对span的管理更有效率。

TCMalloc的核心思想是将内存分为多个级别，从而缩小锁的粒度。在TCMalloc内存管理内部分为两个部分：线程内存(thread memory)和页堆(page heap)。

### 线程内存

每一个内存页都被分为多个固定分配大小规格的空闲列表(free list)用于减少碎片化。每一个线程都可以获得一个用于无锁分配小对象的缓存，可以让并行程序分配小对象(<=32KB)非常高效。

### 页堆

TCMalloc管理的堆由一组page组成，一组连续的page被表示为span。当分配的对象大于32KB，将直接使用page进行内存分配。

当没有足够的空间分配小对象，则会到页堆获取内存。如果页堆没有足够的内存，则页堆会向操作系统申请更多的内存。

## span

### 什么是span

Go与操作系统之间的内存申请和释放，以page为单位(8KB)。一个或多个连续的page组成一个span。span是Go内存管理的基本单位，是以page为单位的内存块。应用程序创建对象，就是通过找到对应规格的span来存储的。mspan是Go的`runtime`用于存储和管理对象的。

简单的说，mspan是一个包含页起始地址、页的span规格和页的数量的双端链表。

<img width="800" src="/images/浅析Golang的内存管理/3.png">

`mspan`结构体的定义在`src/runtime/mheap.go`。

``` go
type mspan struct {
  next *mspan     // 链表下一个span地址
  prev *mspan     // 链表前一个span地址
  list *mSpanList // 链表地址

  startAddr uintptr // 该span在arena区域的起始地址
  npages    uintptr // 该span占用arena区域page的数量
  spanclass   spanClass  // span分类
  ...
}
```

### 怎么区分span

每个span通过span class标识属于哪种规格的span。Go的span规格一共有67种。

规格的定义在`src/runtime/sizeclasses.go`。

``` go
// class  bytes/obj  bytes/span  objects  tail waste  max waste  min align
//     1          8        8192     1024           0     87.50%          8
//     2         16        8192      512           0     43.75%         16
//     3         24        8192      341           8     29.24%          8
...
//    65      27264       81920        3         128     10.00%        128
//    66      28672       57344        2           0      4.91%       4096
//    67      32768       32768        1           0     12.50%       8192
```

- class: span class，规格ID，表示该span可以存储的对象规格类型。
- bytes/obj：表示能存储多大的对象(单位字节)。
- bytes/span：每个span占用堆的大小(单位字节)，即`页数*页`(`npages*8KB`)。
- objects：每个span可存储的对象个数，即`(bytes/span)/(bytes/obj)`。
- tail bytes：每个span产生的内存碎片，即`(bytes/span)%(bytes/obj)`。
- max waste：最大浪费比例。计算公式是`(bytes/obj-最小使用量)*objects/(bytes/span)*100`。

通过span规格表，可以知道在创建对象的时候，选择哪一个span class的span去获取内存空间，尽可能节约地去使用内存空间。

## 内存分配器组件

对象存储在span中，但是如何将各种规格孤立的span串起来？由Go的内存分配器负责。内存分配器采用分级的机制，由3种组件组成：macache、mcentral、mheap。

### mcache

我们知道，Go的强大并发能力依赖于GPM模型。Go runtime调度器会将goroutine绑定在P(processors)上。mcache就是绑定在GMP模型的P上的，每一个P都会有一个mcache与之绑定，用来给goroutine分配存储空间。

所以如果goroutine需要内存可以直接从mcache中获取。由于每个P都拥有各自的mcache，而且同一时间只有一个goroutine运行在逻辑处理器P上，所以从mcache分配内存无需持有锁。

mcache包含所有大小规格的mspan作为缓存。

对于每一种规格都有两个类型：
- scan：包含指针的对象。
- noscan：不包含指针的对象。

采用这种方法的好处之一就是进行gc时，noscan对象无需进一步扫描是否引用其他活跃的对象。

<img width="1000" src="/images/浅析Golang的内存管理/4.png">

`mcache`结构体的定义在`src/runtime/mcache.go`。

``` go
type mcache struct { 
  tiny             uintptr // 申请小对象的起始地址
  tinyoffset       uintptr // 从起始地址tiny开始的偏移量
  local_tinyallocs uintptr // tiny对象分配的数量   
  alloc [numSpanClasses]*mspan // 分配的mspan list，其中numSpanClasses=134，索引是spanClassId
  ...
}
```

关注下`alloc [numSpanClasses]*mspan`这行定义，因为span class一共有67种，为了满足指针对象和非指针对象，每种规格的span准备scan和noscan两种，因此alloc数组有134个`*mspan`，分别指向`mspan`双向链表。

Go对于[16B,32KB]的对象都会从alloc这个数组找，使用这部分的相应大小规格的span分配内存。

``` go
var sizeclass uint8
// 确定规则
if size <= smallSizeMax-8 {
   sizeclass = size_to_class8[(size+smallSizeDiv-1)/smallSizeDiv]
} else {
   sizeclass = size_to_class128[(size-smallSizeMax+largeSizeDiv-1)/largeSizeDiv]
}
size = uintptr(class_to_size[sizeclass])
spc := makeSpanClass(sizeclass, noscan)
span := c.alloc[spc] // 从alloc中通过span class查找span
```

对于更小的对象(<16B)，称之为tiny对象，通过tiny和tinyoffset组合寻找位置分配内存空间。

``` go
off := c.tinyoffset
// 根据不同大小内存对齐
if size&7 == 0 {
   off = round(off, 8)
} else if size&3 == 0 {
   off = round(off, 4)
} else if size&1 == 0 {
   off = round(off, 2)
}
if off+size <= maxTinySize && c.tiny != 0 {
   // tiny+偏移量
   x = unsafe.Pointer(c.tiny + off)
   c.tinyoffset = off + size
   c.local_tinyallocs++
   mp.mallocing = 0
   releasem(mp)
   return x
}
span := c.alloc[tinySpanClass] // 空间不足从alloc重新申请空间用于tiny对象分配
```

### mcentral

mcache中的mspan是动态申请的。当mcache没有可用空间时，mcache会从mcentral的mspans列表获取一个新的所需规格的mspan。

mcentral收集所有给定规格大小的span，每个mcentral对象包含两个mspan列表：
- empty mspanList：没有空闲对象或span已经被mcache缓存的span列表。
- nonempty mspanList：有空闲对象的span列表。

<img width="1000" src="/images/浅析Golang的内存管理/5.png">

`mcentral`结构体的定义在`src/runtime/mcentral.go`。

``` go
type mcentral struct {
  lock      mutex
  spanclass spanClass // span class Id
  nonempty  mSpanList // 空闲的span列表
  empty     mSpanList // 已经被使用的span列表，未归还的会挂载到这里
  nmalloc   uint64 // 这个mcentral分配mspan的累积计数
}
```

由于mcentral是公共资源，会有多个mcache向它申请mspan，所以mcentral必须加锁。另外，由于在P上会处理大小不同的对象（因为绑定了不同的goroutine），mcache需要包含各种规格的span，但同一个mcentral只负责管理一种规格(span class)的mspan(mcentral也是用spanclass标记span规格)。

> 由于有各个规格的span的mcentral，当一个mcache从mcentral申请mspan时，只需在独立的mcentral中使用锁，所以其它任何mcache在同一时间申请不同大小规格的mspan将互不影响。

### mheap

当mcentral的nonempty列表为空的时候，mcentral空间不足，会从mheap获取一系列页用于需要的大小规格的span。

mheap用于管理堆，只有一个全局变量。持有虚拟地址空间。
mheap存储了mcentral的数组，这个数组包含了各个的span的mcentral。

<img width="1000" src="/images/浅析Golang的内存管理/6.png">

`mheap`结构体的定义在`src/runtime/mheap.go`。

``` go
type mheap struct {
  lock      mutex
  allspans []*mspan // 所有的spans
  arenas [1 << arenaL1Bits]*[1 << arenaL2Bits]*heapArena // arenas数组集合，管理各个heapArena
  allArenas []arenaIdx // 所有arena序号集合,可以根据arenaIdx算出对应arenas中的哪一个heapArena

  // 各个规格的mcentral集合
  central [numSpanClasses]struct {
  mcentral mcentral
  pad      [cpu.CacheLinePadSize - unsafe.Sizeof(mcentral{})%cpu.CacheLinePadSize]byte
  }
  ...
}
```

每个Go程序启动的时候，会向操作系统申请一块虚拟内存空间，放在`heapArena`数组里，用于应用程序内存分配。

heapArena分为三个区域：
- spans区域：存储page和span信息，比如一个span的起始地址是什么，有几个page，已使用了多大等。在堆外分配。主要用于GC。
- bitmap区域：用于标记arena区域中哪些地址保存了对象，对象中哪些地址包含了指针，对象是否可回收等。在堆外分配。主要用于GC。
- arena区域：heap区域，用于给程序分配内存，存储了所有在堆上初始化的对象。基本单位是page(8KB)。所有在堆上的内存申请都来自arena。

Go将大于32KB的对象定义为大对象，直接通过mheap分配。同时只被一个P申请，申请时需要加全局锁。大对象分配必须是page的整数倍。如果mheap内存不足，只能向操作系统申请。

## 内存分配规则

- tiny对象(小于16B)内存分配：先向mcache的tiny对象分配器申请；如果不足，向mcache的tinySpanClass规格的span链表申请；如果不足，向mcentral申请对应规格mspan；如果不足，向mheap申请；如果不足，向操作系统申请。
- 小对象(16B~32KB)内存分配：通过计算大小规格，先向mcache申请对应大小规格的mspan；如果不足，向mcentral申请对应规格mspan；如果不足，向mheap申请；如果不足，向操作系统申请。
- 大对象(大于32KB)内存分配：直接向mheap申请；如果不足，向操作系统申请。

> Go会在操作系统分配超大的页(称作arena)。分配一大批页会减少系统调用成本。

<img width="700" src="/images/浅析Golang的内存管理/1.png">
<img width="700" src="/images/浅析Golang的内存管理/2.png">

## 内存分配总结

总结下Go的内存分配思想。

- 使用不同的内存结构为不同大小的对象，用不同的内存缓存级别来分配内存。
- 将一个从操作系统接收的连续地址的块，切分成多级缓存，从而减少锁的使用。
- 根据指定大小分配相应规格的内存，减少内存碎片，以提高内存分配的效率，也加快GC的速度。

<img width="1000" src="/images/浅析Golang的内存管理/7.png">

# Reference

[1]. https://medium.com/@ankur_anand/a-visual-guide-to-golang-memory-allocator-from-ground-up-e132258453ed
[2]. https://draveness.me/golang/
[3]. http://goog-perftools.sourceforge.net/doc/tcmalloc.html

> 讲完Go的内存分配，下一节讲Go的垃圾回收。
