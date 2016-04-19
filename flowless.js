/******************************************************************************/
/**
 * @module flowless
 * @desc Functional asynchronous library
 * @author Lukasz A.J. Wrona (layv.net)
 * @license MIT
 */
/******************************************************************************/

"use strict"
const R = require("ramda")

/******************************************************************************/

const id = x => x

const isPromise = x => x && x instanceof Promise
const isFunction = x => x && x instanceof Function

// Convert to promise and resolve if needed
const callThen = func => function () {
  const args = arguments
  return R.any(isPromise, args)
  ? Promise.all(args).then(args => func(...args))
  : func(...args)
}

const param = key => base => base ? base[key] : undefined

const forOf = (cb, object) => {
  let i = 0
  for (const value of object) {
    cb(value, i, object)
    i++
  }
}

const forIn = (cb, object) => {
  for (const key in object) {
    cb(object[key], key, object)
  }
}

const untilOf = (cb, object) => {
  let i = 0
  for (const value of object) {
    const result = cb(value, i, object)
    if (result) {
      return result
    }
    i++
  }
}

const untilIn = (cb, object) => {
  for (const key in object) {
    const result = cb(object[key], key, object)
    if (result) {
      return result
    }
  }
}

const generic = {
  iterable : {
    create : () => [ ],
    store  : (object, value) => object.push(value),
    each   : forOf,
    until  : untilOf,
  },
  enumerable : {
    create : () => ({ }),
    store  : (object, value, key) => object[key] = value,
    each   : forIn,
    until  : untilIn,
  },
  map : {
    create : () => new Map(),
    store  : (object, value, key) => object.set(key, value),
    each   : (cb, map) => forOf(pair => cb(pair[1], pair[0], map), map),
    until  : (cb, map) => untilOf(pair => cb(pair[1], pair[0], map), map),
  },
  set : {
    create : () => new Set(),
    store  : (object, value) => object.add(value),
    each   : forOf,
    until  : untilOf,
  }
}

const each = {
  map        : generic.map.each,
  set        : generic.set.each,
  iterable   : generic.iterable.each,
  enumerable : generic.enumerable.each,
}

const until = {
  map        : generic.map.until,
  iterable   : generic.iterable.until,
  enumerable : generic.enumerable.until,
  set        : generic.set.until
}

const deref = (alg, target, args) => {
  if (target instanceof Set) {
    return alg.set(...args)
  } else if (target instanceof Map) {
    return alg.map(...args)
  } else if (target[Symbol.iterator]) {
    return alg.iterable(...args)
  } else {
    return alg.enumerable(...args)
  }
}

const createFilter = generic => (pred, object) => {
  let result = generic.create()
  let promise
  generic.each((val, key) => {
    const condition = pred(val, key, object)
    if (isPromise(condition)) {
      if (!promise) {
        promise = condition
      } else {
        promise = promise.then(condition)
      }
      promise.then(condition => {
        if (condition) {
          generic.store(result, val, key)
        }
      })
    } else if (condition) {
      generic.store(result, val, key)
    }
  }, object)
  if (promise) {
    return promise.then(() => result)
  } else {
    return result
  }
}

const filter = {
  set        : createFilter(generic.set),
  map        : createFilter(generic.map),
  enumerable : createFilter(generic.enumerable),
  iterable   : (func, iterable) => {
    const result     = [ ] // results resolved immediately
    const rest       = [ ] // unresolved values
    const conditions = [ ] // asynchronous condition map for rest
    each.iterable((value, key) => {
      const condition = func(value, key, iterable)
      if (conditions.length || isPromise(condition)) {
        conditions.push(condition)
        rest.push(value)
      } else if (condition) {
        result.push(value)
      }
    }, iterable)
    if (conditions.length) {
      return Promise.all(conditions)
      .then(conditions => {
        conditions.forEach((condition, key) => {
          if (condition) {
            result.push(rest[key])
          }
        })
        return result
      })
    }
    return result
  }
}

const createMap = (each, create, assign) => (proc, object) => {
  const out      = create()
  const promises = [ ]
  each((value, key) => {
    const result = proc(value, key, object)
    if (isPromise(result)) {
      promises.push(result)
      result.then(result => assign(out, result, key))
    } else {
      assign(out, result, key)
    }
  }, object)
  if (promises.length) {
    return Promise.all(promises)
    .then(() => out)
  } else {
    return out
  }
}

const map = {
  iterable : (func, iterable) => {
    const result = [ ]
    let asynchronous = false
    each.iterable((value, key) => {
      const element = func(value, key, iterable)
      if (isPromise(element)) {
        asynchronous = true
      }
      result.push(element)
    }, iterable)
    if (asynchronous) {
      return Promise.all(result)
    } else {
      return result
    }
  },

  enumerable : createMap(each.enumerable,
                         () => ({}),
                         (out, result, key) => out[key] = result),

  set : createMap(each.set,
                  () => new Set(),
                  (out, result) => out.add(result)),

  map : createMap(each.map,
                  () => new Map(),
                  (out, result, key) => out.set(key, result))
}


const createReduce = each => (func, prev, enumerable) => {
  each((value, key) => {
    if (isPromise(prev)) {
      prev = prev.then(prev => func(prev, value, key, enumerable))
    } else {
      prev = func(prev, value, key, enumerable)
    }
  }, enumerable)
  return prev
}

const reduce = map.enumerable(createReduce, each)

// first promise that passes predicate will resolve
const findPromise = (func, promises) => new Promise((resolve, reject) => {
  let resolvedCount = 0
  for (const promise of promises) {
    promise.then(value => {
      if (func(value)) {
        resolve(value)
      } else {
        resolvedCount++
        if (resolvedCount === promises.length) {
          resolve(undefined)
        }
      }
    })
    .catch(reject)
  }
})

const createFind = until => (func, object) => {
  const promises = [ ]
  let result
  if (until((value, key) => {
    const condition = func(value, key, object)
    if (isPromise(condition)) {
      promises.push(condition.then(condition => condition
                                   ? { value }
                                   : undefined))
    } else if (condition) {
      result = value
      return condition
    }
  }, object)) {
    return result
  } else if (promises.length) {
    return findPromise(id, promises).then(param("value"))
  }
}

const find = {
  iterable : (func, iterable) => {
    let i = 0
    let promise
    for (const value of iterable) {
      if (promise) {
        promise = promise.then(container => {
          if (container) {
            return container
          }
          const condition = func(value, i)
          if (isPromise(condition)) {
            return condition.then(condition => {
              if (condition) {
                return { value }
              }
              i += 1
            })
          } else if (condition) {
            return { value }
          } else {
            i += 1
          }
        })
      } else {
        const condition = func(value, i)
        if (isPromise(condition)) {
          promise = condition.then(condition => {
            if (condition) {
              return { value }
            }
            i += 1
          })
        } else if (condition) {
          return value
        } else {
          i += 1
        }
      }
    }
    if (promise) {
      return promise.then(param("value"))
    }
  },
  enumerable : createFind(until.enumerable),
  map        : createFind(until.map),
}
find.set = find.iterable

const createSome = until => (pred, object) => {
  let promises = [ ]
  return until((value, key) => {
    const condition = pred(value, key, object)
    if (isPromise(condition)) {
      promises.push(condition)
    } else {
      return condition
    }
  }, object)
  || !!promises.length
     && findPromise(id, promises).then(result => !!result)
}

const some = {
  iterable   : createSome(until.iterable),
  enumerable : createSome(until.enumerable),
  map        : createSome(until.map),
  set        : createSome(until.set)
}

const rangeAsc = function*(l, r) {
  for (; l <= r; l++) {
    yield l
  }
}

const rangeDesc = function*(l, r) {
  for (; l >= r; l--) {
    yield l
  }
}

const F = module.exports = callThen(function(a1) {
  if (arguments.length === 1 && isFunction(a1)) {
    return F.curry(a1)
  } else {
    return F.compose(...R.map(R.ifElse(isFunction, id, param), arguments))
  }
})

// Essentials

/**
 * Performs left-to-right function composition. The leftmost function may accept
 * multiple arguments, other ones must be unary. If one of functions resolves
 * value through promise, wait for it and apply next function on the result.
 * @function compose
 * @static
 * @param {Function} function... Functions to concatenate
 * @return {Function} New composed function
 * @example
 * const fSync = F.compose(a => a * 2,
 *                         a => Math.pow(a, 2),
 *                         a => a + 1)
 * fSync(1) // returns 5
 * fSync(2) // returns 17
 *
 * const fAsync = F.compose(a => Promise.resolve(a * 2),
 *                          a => Math.pow(a, 2),
 *                          a => Promise.resolve(a + 1))
 * fAsync(1).then(result => {  }) // result is 5
 * fAsync(2).then(result => {  }) // result is 17
 */
F.compose = function() {
  const funcs = arguments;
  const f1 = funcs[0]
  return function () {
    if (R.any(isPromise, arguments)) {
      funcs[0] = () => Promise.all(arguments).then(args => f1(...args))
    } else {
      funcs[0] = () => f1(...arguments)
    }
    let value
    let isError = false // is value an error
    for (let i = 0, il = funcs.length; i < il; i++) {
      const func = funcs[i]
      if (isPromise(value)) {
        if (func.catcher) {
          value = value.catch(func)
        } else {
          value = value.then(func)
        }
      } else if (!isError ^ func.catcher) {
        try {
          value = func(value)
          isError = false
        } catch (error) {
          value = error
          isError = true
        }
      }
    }
    if (isError) {
      throw value
    } else {
      return value
    }
  }
}

/**
 * Create exception handler, use only in conjunction with F.compose. Does also
 * catch promise rejections
 * @function catch
 * @static
 * @param {Function} handler Exception handler. Accepts only one argument -
 * thrown error
 * @return {Function} Function that will handle exceptions thrown inside
 * composed function
 * @example
 * const param = F(object => object.param,  // throws if object is undefined
 *                 F.catch(() => "param not found"))
 * param({ param : 1 }) // returns 1
 * param(undefined)     // returns "param not found"
 */
F.catch = handler => {
  handler.catcher = true
  return handler
}

F.curryN = (length, func) => R.curryN(length, callThen(func))

F.curry = func => F.curryN(func.length, func)

F.range = callThen((a1, a2) => {
  if (a2 === undefined) {
    a2 = a1
    a1 = 0
  }
  if (a1 <= a2) {
    return rangeAsc(a1, a2)
  } else {
    return rangeDesc(a1, a2)
  }
})

F.args = callThen(function() {
  return [ ...arguments ]
})

// Utilities

/**
 * <pre>key -> base -> value</pre>
 * Safely extract property from base object. If object is null or undefined,
 * will return undefined.
 * @function param
 * @static
 * @param {Mixed} key Name of the property.
 * @param {Mixed} base Object from which the property should be extracted
 * @return {Mixed} Value of the property
 * @example
 * const getNestedProperty = F(F.param("nested"), F.param("property"))
 * const object = {
 *   nested : {
 *     property : "Nested properties are terrible"
 *   }
 * }
 * getNestedProperty(object) // returns "Nested properties are terrible"
 * getNestedProperty({ })    // returns undefined
 *
 * // You may also construct it this way
 * const getNestedProperty = F("nested", "property")
 */
F.param = F.curry((key, base) => base ? base[key] : undefined)

/**
 * Create if ... then chain. Function requires at least 2 arguments. Predicates
 * may resolve through promise. If that's the case function will wait for
 * predicate to resolve and return eventual result in promise.
 *
 * Order of functions is always as follows:
 * <pre>ifFunc, thenFunc [, elseIfFunc, thenFunc... [, elseFunc]</pre>
 * @function ifElse
 * @static
 * @param {Function} function... Function only accepts functions
 * @return {Mixed} function returns result of thenFunc or undefined if elseFunc
 * is not specified. If one of predicates resolves through a promise, function
 * will return result in a promise.
 * @example
 * const sgn = F.ifElse(x => x > 0, // if
 *                      () => 1,    // then
 *
 *                      x => x < 0, // else if
 *                      () => -1,   // then
 *
 *                      () => 0)    // else
 *
 * sgn(5)       // returns 1
 * sgn(-0.5)    // returns -1
 * sgn("Hello") // returns 0
 * // condition resolving through promise
 * const abs = F.ifElse(x => Promise.resolve(x > 0), // if
 *                      x => x,                      // then
 *                      x => x * -1)                 // else
 * abs(-3) // Promise resolving to 3
 */
F.ifElse = callThen(function () {
  const funcs = arguments
  return value => {
    let promise
    for (let i = 0, il = funcs.length - 1; i < il; i += 2) {
      const pred = funcs[i]
      const then = funcs[i + 1]
      if (promise) {
        promise = promise.then(container => {
          if (container) {
            return container
          } else {
            const condition = pred(value)
            if (isPromise(condition)) {
              return condition.then(condition => {
                if (condition) {
                  return { value : then(value) }
                }
              })
            } else if (condition) {
              return { value : then(value) }
            }
          }
        })
      } else {
        const condition = pred(value)
        if (isPromise(condition)) {
          promise = condition
          .then(condition => {
            if (condition) {
              return { value : then(value) }
            }
          })
        } else if (condition) {
          return then(value)
        }
      }
    }
    if (promise) {
      return promise
      .then(container => {
        if (container) {
          return container.value
        } else if (funcs.length % 2) {
          return funcs[funcs.length - 1](value)
        }
      })
    } else if (funcs.length % 2) {
      return funcs[funcs.length - 1](value)
    }
  }
})

/**
 * <pre>(value -> key -> object -> undefined) -> object -> undefined</pre>
 * Iterate over Array, enumerable, Iterable, Map, Set or function generator.
 * <br>
 * If object is iterable (array, arguments, generator, it'll use for...of loop
 * If key is missing (map, generator), key will be a count of iterations. In
 * case of map, it'll use pair[0] as key and pair[1] as value
 * <br>
 * If object is enumerable (Object literal) it'll use for...in loop.
 * If you want to specify iteration mechanism on your own, use one of the
 * following functions:
 * <ul>
 * <li>F.forEachIterable
 * <li>F.forEachEnumerable
 * <li>F.forEachMap
 * <li>F.forEachSet
 * </ul>
 * @function forEach
 * @static
 * @param {Function} callback Callback function. Accepts 3 arguments - value,
 * key and iterated object
 * @param {Mixed} object Object iterated over
 * @example
 * const eachLog = F.forEach((value, key) => console.log(value, key))
 * eachLog(new Map([ 'key1', 'value1' ], [ 'key2', 'value2' ]) // prints:
 *                                                             // key1 value1
 *                                                             // key2 value2
 */
F.forEach = F.curry(function (func, object) {
  deref(each, object, arguments)
})

F.forEachEnumerable = F.curry(each.enumerable)
F.forEachIterable   = F.curry(each.iterable)
F.forEachSet        = F.curry(each.set)
F.forEachMap        = F.curry(each.map)

F.filter = F.curry(function (func, object) {
  return deref(filter, object, arguments)
})
F.filterEnumerable = F.curry(filter.enumerable)
F.filterIterable   = F.curry(filter.iterable)
F.filterSet        = F.curry(filter.set)
F.filterMap        = F.curry(filter.map)

F.map = F.curry(function (func, object) {
  return deref(map, object, arguments)
})
F.mapEnumerable = F.curry(map.enumerable)
F.mapIterable   = F.curry(map.iterable)
F.mapSet        = F.curry(map.set)
F.mapMap        = F.curry(map.map)

F.reduce = F.curry(function(func, prev, object) {
  return deref(reduce, object, arguments)
})
F.reduceIterable   = F.curry(reduce.iterable)
F.reduceEnumerable = F.curry(reduce.enumerable)
F.reduceMap        = F.curry(reduce.map)
F.reduceSet        = F.curry(reduce.set)

F.find = F.curry(function(func, object) {
  return deref(find, object, arguments)
})
F.findEnumerable = F.curry(find.enumerable)
F.findIterable   = F.curry(find.iterable)
F.findMap        = F.curry(find.map)
F.findSet        = F.curry(find.set)

F.some = F.curry(function(func, object) {
  return deref(some, object, arguments)
})

F.every = F.curry((func, object) =>
  F(F.some(F(func, R.not)), R.not)(object))

const match = pred => {
  if (pred instanceof Function) {
    if (pred === Boolean) {
      return value => typeof value === "boolean"
    } else if (pred === Number) {
      return value => typeof value === "number"
    } else if (pred === String) {
      return value => typeof value === "string"
    } else if (pred.prototype === id.prototype) {
      return value => pred(value)
    } else {
      return value => value && value instanceof pred
    }
  } else if (pred instanceof RegExp) {
    return value => pred.test(value)
  } else if (pred instanceof Array) {
    const possible = pred.map(match)
    return value => F.some(pred => pred(value), possible)
  } else if (pred instanceof Object) {
    const possible = map.enumerable(match, pred)
    const keys     = Object.keys(possible)
    return value => {
      if (!value || !(value instanceof Object)
          || Object.keys(value).length !== keys.length) {
        return false
      }
      return F.every((possible, key) => possible(value[key]), possible)
    }
  } else {
    return value => value === pred
  }
}

F.match = match
