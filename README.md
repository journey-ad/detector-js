# Detector.js

> [!WARNING]  
> 此项目通过人工智能辅助生成，可能存在未知的问题或错误，使用前请充分测试以确保稳定性

基于 JavaScript `Proxy` API 的深度监控工具，实现对象与函数交互的全面拦截

`detector.js` 是一个轻量级监控库，能够精确追踪 JavaScript 对象和函数的所有交互行为，包括属性访问、值修改、函数调用及构造函数实例化。   
基于原生 `Proxy` API 构建，提供结构化的事件系统，适用于调试分析、状态监控、性能追踪和响应式系统开发。

### 核心特性

  - **深度拦截**：递归封装嵌套对象、数组和函数返回值
  - **完整事件覆盖**：支持 `get`、`set`、`apply`、`construct`、`deleteProperty` 等操作类型，以及 `Promise` 的 `apply:resolved` 和 `apply:rejected` 状态
  - **异步监控**：通过劫持 `Promise` 的 `then`/`catch` 方法，实现异步函数执行结果的状态追踪
  - **智能过滤系统**：通过 `include` 和 `exclude` 配置，实现对特定路径的精准监控
  - **直观路径表示**：自动将内部路径数组转换为标准 JavaScript 访问语法（如 `'a.b[2].c'`）
  - **内存安全保障**：采用 `WeakMap` 和 `WeakSet` 防止内存泄漏，妥善处理循环引用
  - **健壮性设计**：在 `Proxy` 创建失败或事件处理异常时优雅降级，确保主程序稳定运行

### 快速开始

[在线演示](https://journey-ad.github.io/detector-js/test.html)

---

### 安装使用

detector.js 采用 UMD 格式，支持多种引入方式：

**浏览器直接引入：**
```html
<script src="./detector.js"></script>

<script>
  // createDetector 方法将在全局可用
  const detector = createDetector(target, onEvent, opts);
</script>
```

**或是通过打包器如 `webpack`、`rollup` 等以 ES Module 方式引入：**
```js
import { createDetector } from './detector.js';

const detector = createDetector(target, onEvent, opts);
```

### API 文档

核心函数为 `createDetector`：

#### `createDetector(target, onEvent, opts)`

**参数：**
  - `target`: 需要监控的目标对象或函数
  - `onEvent`: 事件触发时的回调函数，接收事件对象作为参数
  - `opts`: 可选配置对象

**事件对象结构：**

`onEvent` 回调函数接收的事件对象包含以下属性：

```typescript
type Event = {
  type: 'get' | 'set' | 'apply' | 'apply:resolved' | 'apply:rejected' | 'construct' | 'deleteProperty'; // 事件类型
  timestamp: number;            // 事件触发的时间戳
  target?: any;                 // 事件触发的目标对象
  accessor: string;             // JS语法访问路径，如 'a.b[2].c'
  path: Array<string | Symbol>; // 访问路径数组，如 ['a', 'b', 2, 'c']
  prop?: string | Symbol;       // 访问的属性名
  args?: Array<any>;            // 调用时的参数列表
  value?: any;                  // set 操作的 value
  result?: any;                 // get 或 apply 得到的结果
  isPromise?: boolean;          // 是否为 Promise 类型
  error?: any;                  // 错误对象
};
```

**`type` 事件类型**

  - `get`: 属性访问操作
  - `set`: 属性赋值操作
  - `apply`: 函数调用操作
  - `apply:resolved`: Promise 成功状态
  - `apply:rejected`: Promise 失败状态
  - `construct`: 构造函数调用
  - `deleteProperty`: 属性删除操作

**配置选项 (opts)：**

  - `depthLimit?: number`: 递归封装的最大深度，默认无限制
  - `include?: (string|RegExp)[]`: 路径白名单，仅监控匹配的属性访问
  - `exclude?: (string|RegExp)[]`: 路径黑名单，忽略匹配的属性访问

---

### 使用示例

#### 1. 对象属性监控

监控对象的属性访问和修改操作：

```javascript
import { createDetector } from './detector.js';

const user = {
  name: 'Alice',
  age: 30,
  address: {
    city: 'Wonderland'
  }
};

const detector = createDetector(user, event => {
  console.log(`[${event.type}]`, `路径: ${event.accessor}`);
  if (event.type === 'set') {
    console.log(`- 值:`, event.value);
  }
});

// 访问属性
console.log(detector.name);         // [get] 路径: name
console.log(detector.address.city); // [get] 路径: address
                                    // [get] 路径: address.city

// 设置属性
detector.age = 31;                  // [set] 路径: age - 值: 31
detector.address.city = 'New York'; // [set] 路径: address.city - 值: New York
```

#### 2. 函数调用监控

监控函数调用的参数和返回值：

```javascript
import { createDetector } from './detector.js';

const calculator = {
  add: (a, b) => a + b,
  multiply: (a, b) => a * b
};

const detector = createDetector(calculator, event => {
  if (event.type === 'apply') {
    console.log(`[${event.type}]`, `函数: ${event.accessor}`, `参数: [${event.args}]`);
    console.log(`- 结果:`, event.result);
  }
});

detector.add(5, 10); // [apply] 函数: add 参数: [5,10] - 结果: 15
```

#### 3. 路径过滤配置

使用 `include` 和 `exclude` 实现精准监控：

```javascript
import { createDetector } from './detector.js';

const data = {
  public: { id: 1 },
  private: { key: 'secret' },
  status: 'active'
};

const detector = createDetector(data, event => {
  console.log(`[${event.type}] 路径: ${event.accessor}`);
}, {
  // 仅监控 'public' 路径下的操作
  include: ['public']
});

detector.public.id;           // [get] 路径: public.id
detector.private.key;         // (无输出)
detector.status = 'inactive'; // (无输出)
```

### 许可证

[MIT License](./LICENSE)
