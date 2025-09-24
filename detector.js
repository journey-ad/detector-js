/**
 * createDetector(target, onEvent, opts)
 *
 * - 会对任意对象/函数包装 proxy（包括外部已有的 Proxy），保证我们能拦截到访问/调用
 * - 但不会重复包装我们自己创建的 wrapper（用 objToWrapper 缓存）
 * - 不包装 Promise（直接返回原 Promise），但会 hook then/catch 及其最终值
 *
 * opts: {
 *   enable?: boolean,              // 是否启用检测，默认 true
 *   depthLimit?: number,           // 深度限制，默认 Infinity
 *   include?: (string|RegExp)[],   // 白名单：只监听匹配的路径
 *   exclude?: (string|RegExp)[]    // 黑名单：排除匹配的路径
 * }
 * 
 * onEvent(event) 回调：
 *  event: {
 *    type: 'get'|'set'|'apply'|'apply:resolved'|'apply:rejected'|'construct'|'deleteProperty',
 *    timestamp: number,          // 事件触发的时间戳
 *    target?: any,               // 事件触发的目标对象
 *    accessor: string,           // JS语法访问路径，如 'a.b[2].c'
 *    path: Array<string|Symbol>, // 访问路径数组，如 ['a', 'b', 2, 'c']
 *    prop?: string|Symbol,       // 访问的属性名
 *    args?: Array,               // 调用时的参数列表
 *    value?: any,                // set 操作的 value
 *    result?: any,               // get 或 apply 得到的结果
 *    isPromise?: boolean,        // 是否为 Promise 类型
 *    error?: any,                // 错误对象
 *  }
 */

// 事件类型常量
const EVENT_TYPES = {
  GET: 'get',
  SET: 'set',
  APPLY: 'apply',
  APPLY_RESOLVED: 'apply:resolved',
  APPLY_REJECTED: 'apply:rejected',
  CONSTRUCT: 'construct',
  DELETE_PROPERTY: 'deleteProperty'
};

// 内置 Symbol 常量集合 - 这些方法直接返回原始值，避免代理干扰
const BUILTIN_SYMBOLS = new Set([
  Symbol.iterator,        // 数组/对象迭代
  Symbol.asyncIterator,   // 异步迭代
  Symbol.toPrimitive,     // 类型转换
  Symbol.hasInstance,     // instanceof 检查
  Symbol.toStringTag,     // Object.prototype.toString
  Symbol.species          // 构造函数派生
]);

// 路径常量
const PATH_MARKERS = {
  SYNC_RESULT: '[sync-result]',
  CONSTRUCTED: '[constructed]'
};

function createDetector(target, onEvent, opts = {}) {
  if (typeof onEvent !== 'function') {
    throw new TypeError('onEvent must be a function');
  }

  // 检查是否启用检测，默认启用
  if (opts.enable === false) {
    return target;
  }

  // target 有效性检查
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return target;
  }

  const depthLimit = typeof opts.depthLimit === 'number' ? Math.max(0, opts.depthLimit) : Infinity;
  const include = Array.isArray(opts.include) ? opts.include : null;
  const exclude = Array.isArray(opts.exclude) ? opts.exclude : null;
  const objToWrapper = new WeakMap();
  const processingObjects = new WeakSet(); // 循环引用检测

  // 路径匹配函数
  const matchPatterns = (text, patterns) => {
    if (!patterns || patterns.length === 0) return false;
    return patterns.some(pattern => {
      if (typeof pattern === 'string') {
        if (text === pattern) return true;
        if (text.startsWith(pattern + '.')) return true;
        if (text.startsWith(pattern + '[')) return true;
        return false;
      } else if (pattern instanceof RegExp) {
        return pattern.test(text);
      }
      return false;
    });
  };

  // 检查路径是否应该被监听
  const shouldWatch = (accessor) => {
    // 如果设置了 include，必须匹配 include
    if (include) {
      const includeMatch = matchPatterns(accessor, include);
      if (!includeMatch) return false;
    }

    // 如果设置了 exclude，不能匹配 exclude
    if (exclude) {
      const excludeMatch = matchPatterns(accessor, exclude);
      if (excludeMatch) return false;
    }

    return true;
  };

  // 辅助函数
  const isPromise = v => v instanceof Promise;
  const isBuiltinMethod = prop =>
    BUILTIN_SYMBOLS.has(prop) || (typeof prop === 'string' && prop.startsWith('@@'));

  // 统一的事件触发器
  const emitEvent = (eventData) => {
    // 路径过滤检查
    if (!shouldWatch(eventData.accessor)) return;

    try {
      onEvent(eventData);
    } catch (e) {
      // 吞掉 onEvent 内部异常，避免影响原本逻辑
      console.warn('Detector onEvent error:', e);
    }
  };

  // 路径转换为JS访问器语法
  const pathToAccessor = (path) => {
    if (!path || path.length === 0) {
      return '';
    }

    // 检查是否为有效的JS标识符
    const isValidIdentifier = (s) =>
      typeof s === 'string' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s);

    return path.reduce((acc, segment, index) => {
      // 处理 Symbol 类型
      if (typeof segment === 'symbol') {
        // 优先使用 Symbol.keyFor 来获取全局 Symbol
        const key = Symbol.keyFor(segment);
        if (key) {
          return `${acc}[Symbol.for("${key}")]`;
        }
        // 对于非全局 Symbol，使用其描述信息
        // Symbol.iterator 的描述就是 "Symbol.iterator"
        return `${acc}[${segment.description || segment.toString()}]`;
      }

      // 处理特殊标记，例如 '[sync-result]'
      if (typeof segment === 'string' && segment.startsWith('[') && segment.endsWith(']')) {
        return `${acc}${segment}`;
      }

      // 处理数字索引
      if (typeof segment === 'number' || /^\d+$/.test(segment)) {
        return `${acc}[${segment}]`;
      }

      // 统一处理点号（.）和方括号（[]）的路径段
      const segmentString = String(segment); // 将路径段转换为字符串，以进行正则检查
      const isIdentifier = isValidIdentifier(segmentString); // 检查是否是合法的JS标识符，如 'name', 'myProp'

      if (index === 0) {
        // 处理根路径
        return isIdentifier
          ? segmentString // 如果是合法标识符，直接返回，如 'user'
          : `[${JSON.stringify(segment)}]`; // 否则使用方括号，并用JSON.stringify确保字符串安全，如 'user-name' -> '["user-name"]'
      } else {
        // 处理嵌套路径
        return isIdentifier
          ? `${acc}.${segmentString}` // 如果是合法标识符，用点号连接，如 'user.name'
          : `${acc}[${JSON.stringify(segment)}]`; // 否则用方括号，如 'user["my-account"]'
      }
    }, '');
  };

  // 构建基础事件数据
  const createEventBase = (type, path, target, prop = undefined) => ({
    type,
    path,
    get accessor() { return pathToAccessor(path); },
    prop,
    target,
    timestamp: Date.now(),
  });

  // 执行操作并处理错误
  const executeOperation = (operation, eventBase) => {
    try {
      const result = operation();
      emitEvent({ ...eventBase, result, isPromise: isPromise(result) });
      return result;
    } catch (error) {
      emitEvent({ ...eventBase, error });
      throw error;
    }
  };

  // Promise 处理器
  const handlePromiseResult = (promise, eventBase) => {
    promise.then(
      result => emitEvent({
        ...eventBase,
        type: EVENT_TYPES.APPLY_RESOLVED,
        result,
        isPromise: true
      }),
      error => emitEvent({
        ...eventBase,
        type: EVENT_TYPES.APPLY_REJECTED,
        error,
        isPromise: true
      })
    );
  };

  // Handler 方法提取
  const createGetHandler = (path, depth) => (target, prop, receiver) => {
    const eventBase = createEventBase(EVENT_TYPES.GET, path.concat(prop), target, prop);

    // 内置方法特殊处理
    if (isBuiltinMethod(prop)) {
      const value = Reflect.get(target, prop, receiver);
      emitEvent({ ...eventBase, result: value, isPromise: false });
      return value;
    }

    // 常规属性访问
    const value = executeOperation(() => Reflect.get(target, prop, receiver), eventBase);

    // Promise 直接返回，其他值继续包装
    return isPromise(value) ? value : createProxy(value, path.concat(prop), depth + 1);
  };

  const createSetHandler = (path) => (target, prop, value, receiver) => {
    emitEvent({
      ...createEventBase(EVENT_TYPES.SET, path.concat(prop), target, prop),
      value
    });
    return Reflect.set(target, prop, value, receiver);
  };

  const createApplyHandler = (path, depth) => (target, thisArg, argsList) => {
    const eventBase = createEventBase(EVENT_TYPES.APPLY, path, target);
    eventBase.args = argsList;

    const result = executeOperation(() => Reflect.apply(target, thisArg, argsList), eventBase);

    // Promise 特殊处理
    if (isPromise(result)) {
      handlePromiseResult(result, eventBase);
      return result;
    }

    // 非 Promise 结果继续包装
    return createProxy(result, path.concat(PATH_MARKERS.SYNC_RESULT), depth + 1);
  };

  const createConstructHandler = (path, depth) => (target, argsList, newTarget) => {
    const eventBase = createEventBase(EVENT_TYPES.CONSTRUCT, path, target);
    eventBase.args = argsList;

    const instance = executeOperation(() => Reflect.construct(target, argsList, newTarget), eventBase);
    return createProxy(instance, path.concat(PATH_MARKERS.CONSTRUCTED), depth + 1);
  };

  const createDeleteHandler = (path) => (target, prop) => {
    emitEvent(createEventBase(EVENT_TYPES.DELETE_PROPERTY, path.concat(prop), target, prop));
    return Reflect.deleteProperty(target, prop);
  };

  function createProxy(obj, path = [], depth = 0) {
    // 快速返回条件
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
    if (depth > depthLimit) return obj;
    if (isPromise(obj)) return obj;

    // 缓存检查
    const cached = objToWrapper.get(obj);
    if (cached) return cached;

    // 循环引用检测
    if (processingObjects.has(obj)) return obj;
    processingObjects.add(obj);

    // 创建优化的 handler
    const handler = {
      get: createGetHandler(path, depth),
      set: createSetHandler(path),
      apply: createApplyHandler(path, depth),
      construct: createConstructHandler(path, depth),
      deleteProperty: createDeleteHandler(path),

      // 其他操作直接透传，提升性能
      has: (target, prop) => Reflect.has(target, prop),
      ownKeys: target => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (target, prop) => Reflect.getOwnPropertyDescriptor(target, prop),
      defineProperty: (target, prop, descriptor) => Reflect.defineProperty(target, prop, descriptor)
    };

    // 创建并缓存 wrapper
    let wrapper;
    try {
      wrapper = new Proxy(obj, handler);
      objToWrapper.set(obj, wrapper);
    } catch (error) {
      // Proxy 创建失败时返回原对象
      processingObjects.delete(obj);
      return obj;
    }

    processingObjects.delete(obj);
    return wrapper;
  }

  return createProxy(target, [], 0);
}

// UMD wrapper
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    // CommonJS
    module.exports = factory();
  } else {
    // Browser globals
    root.createDetector = factory().createDetector;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  return {
    createDetector: createDetector
  };
}));