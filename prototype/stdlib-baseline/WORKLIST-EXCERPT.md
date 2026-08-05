# Worklist excerpt — the 18 members a reviewer would sign first

Full generated worklist: run `node classify.mjs` (out/worklist.md, ~600 KB).

## `Array.prototype.map` — proposed group 2
- lib: es5 · spec: `Array.prototype.map ( callback [ , thisArg ] )`
- [type-excluded] receiver is the declaring interface (non-nullable)
  - site: Let obj be ? ToObject(this value).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [review] coerces a value not traceable to a declared parameter
  - site: Let length be ? LengthOfArrayLike(obj).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [type-excluded] callable-param declared as a function type
  - site: If IsCallable(callback) is false, throw a TypeError exception.
  - why: If IsCallable(callback) is false, throw a TypeError exception.
- [review] unbucketed root op ArraySpeciesCreate
  - site: Let array be ? ArraySpeciesCreate(obj, length).
  - why: If IsConstructor(ctor) is false, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let kPresent be ? HasProperty(obj, propertyKey).
  - why: [[HasProperty]] ( propertyKey ): If targetDesc.[[Configurable]] is false, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let kValue be ? Get(obj, propertyKey).
  - why: [[Get]] ( propertyKey, receiver ): If targetEnv is empty, throw a ReferenceError exception.
- [conditional] runs parameter callbackfn
  - site: Let mappedValue be ? Call(callback, thisArg, « kValue, 𝔽(k), obj »).
  - why: If IsCallable(func) is false, throw a TypeError exception.
- [type-reachable] mutates the receiver; frozen/sealed is type-conformant
  - site: Perform ? CreateDataPropertyOrThrow(array, propertyKey, mappedValue).
  - why: If success is false, throw a TypeError exception.

## `Array.prototype.filter` — proposed group 2
- lib: es5 · spec: `Array.prototype.filter ( callback [ , thisArg ] )`
- [type-excluded] receiver is the declaring interface (non-nullable)
  - site: Let obj be ? ToObject(this value).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [review] coerces a value not traceable to a declared parameter
  - site: Let length be ? LengthOfArrayLike(obj).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [type-excluded] callable-param declared as a function type
  - site: If IsCallable(callback) is false, throw a TypeError exception.
  - why: If IsCallable(callback) is false, throw a TypeError exception.
- [review] unbucketed root op ArraySpeciesCreate
  - site: Let array be ? ArraySpeciesCreate(obj, 0).
  - why: If IsConstructor(ctor) is false, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let kPresent be ? HasProperty(obj, propertyKey).
  - why: [[HasProperty]] ( propertyKey ): If targetDesc.[[Configurable]] is false, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let kValue be ? Get(obj, propertyKey).
  - why: [[Get]] ( propertyKey, receiver ): If targetEnv is empty, throw a ReferenceError exception.
- [conditional] runs parameter predicate
  - site: Let selected be ToBoolean(? Call(callback, thisArg, « kValue, 𝔽(k), obj »)).
  - why: If IsCallable(func) is false, throw a TypeError exception.
- [type-reachable] mutates the receiver; frozen/sealed is type-conformant
  - site: Perform ? CreateDataPropertyOrThrow(array, ! ToString(𝔽(to)), kValue).
  - why: If success is false, throw a TypeError exception.

## `Array.prototype.forEach` — **REVIEW**
- lib: es5 · spec: `Array.prototype.forEach ( callback [ , thisArg ] )`
- [type-excluded] receiver is the declaring interface (non-nullable)
  - site: Let obj be ? ToObject(this value).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [review] coerces a value not traceable to a declared parameter
  - site: Let length be ? LengthOfArrayLike(obj).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [type-excluded] callable-param declared as a function type
  - site: If IsCallable(callback) is false, throw a TypeError exception.
  - why: If IsCallable(callback) is false, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let kPresent be ? HasProperty(obj, propertyKey).
  - why: [[HasProperty]] ( propertyKey ): If targetDesc.[[Configurable]] is false, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let kValue be ? Get(obj, propertyKey).
  - why: [[Get]] ( propertyKey, receiver ): If targetEnv is empty, throw a ReferenceError exception.
- [conditional] runs parameter callbackfn
  - site: Perform ? Call(callback, thisArg, « kValue, 𝔽(k), obj »).
  - why: If IsCallable(func) is false, throw a TypeError exception.

## `Array.prototype.push` — proposed group 2
- lib: es5 · spec: `Array.prototype.push ( ...items )`
- [type-excluded] receiver is the declaring interface (non-nullable)
  - site: Let obj be ? ToObject(this value).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [review] coerces a value not traceable to a declared parameter
  - site: Let length be ? LengthOfArrayLike(obj).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [review] explicit throw with a value-dependent condition
  - site: If length + argCount > 253 - 1, throw a TypeError exception.
  - why: If length + argCount > 253 - 1, throw a TypeError exception.
- [type-reachable] mutates the receiver; frozen/sealed is type-conformant
  - site: Perform ? Set(obj, ! ToString(𝔽(length)), item, true).
  - why: If success is false and throw is true, throw a TypeError exception.
- [type-reachable] mutates the receiver; frozen/sealed is type-conformant
  - site: Perform ? Set(obj, "length", 𝔽(length), true).
  - why: If success is false and throw is true, throw a TypeError exception.

## `Array.prototype.join` — **REVIEW**
- lib: es5 · spec: `Array.prototype.join ( separator )`
- [type-excluded] receiver is the declaring interface (non-nullable)
  - site: Let obj be ? ToObject(this value).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [review] coerces a value not traceable to a declared parameter
  - site: Let length be ? LengthOfArrayLike(obj).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [type-excluded] coerces separator: declared string
  - site: Else, let sep be ? ToString(separator).
  - why: If arg is a Symbol, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let element be ? Get(obj, ! ToString(𝔽(k))).
  - why: [[Get]] ( propertyKey, receiver ): If targetEnv is empty, throw a ReferenceError exception.
- [review] coerces a value not traceable to a declared parameter
  - site: Let elementString be ? ToString(element).
  - why: If arg is a Symbol, throw a TypeError exception.

## `Object.keys` — proposed group 1
- lib: es5, es2015.core · spec: `Object.keys ( obj )`
- [type-excluded] coerces o: declared object is never null/undefined
  - site: Let coerced be ? ToObject(obj).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let keyList be ? EnumerableOwnProperties(coerced, key).
  - why: [[OwnPropertyKeys]] ( ): If trapResult contains any duplicate entries, throw a TypeError exception.

## `Object.entries` — proposed group 1
- lib: es2017.object · spec: `Object.entries ( obj )`
- [type-excluded] coerces o: declared { [s: string]: T; } | ArrayLike<T> is never null/undefined
  - site: Let coerced be ? ToObject(obj).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let entryList be ? EnumerableOwnProperties(coerced, key+value).
  - why: [[OwnPropertyKeys]] ( ): If trapResult contains any duplicate entries, throw a TypeError exception.

## `JSON.parse` — **REVIEW**
- lib: es5 · spec: `JSON.parse ( text [ , reviver ] )`
- [type-excluded] coerces text: declared string
  - site: Let jsonString be ? ToString(text).
  - why: If arg is a Symbol, throw a TypeError exception.
- [review] unbucketed root op ParseJSON
  - site: Let parseResult be ? ParseJSON(jsonString).
  - why: If StringToCodePoints(text) is not a valid JSON text as specified in ECMA-404, throw a SyntaxError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Return ? InternalizeJSONProperty(root, rootName, reviver, snapshot).
  - why: [[Get]] ( propertyKey, receiver ): If targetEnv is empty, throw a ReferenceError exception.

## `JSON.stringify` — proposed group 2
- lib: es5 · spec: `JSON.stringify ( value [ , replacer [ , space ] ] )`
- [type-excluded] brand check discharged by the declared receiver type
  - site: Let isArray be ? IsArray(replacer).
  - why: If proxy.[[ProxyTarget]] is null, throw a TypeError exception.
- [type-reachable] coerces replacer: declared (this: any, key: string, value: any) => any admits Symbol/BigInt/objects
  - site: Let length be ? LengthOfArrayLike(replacer).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let propertyValue be ? Get(replacer, propertyKey).
  - why: [[Get]] ( propertyKey, receiver ): If targetEnv is empty, throw a ReferenceError exception.
- [type-reachable] coerces replacer: declared (this: any, key: string, value: any) => any admits Symbol/BigInt/objects
  - site: If propertyValue has a [[StringData]] or [[NumberData]] internal slot, set item to ? ToString(propertyValue).
  - why: If arg is a Symbol, throw a TypeError exception.
- [type-excluded] coerces space: declared string | number
  - site: Set space to ? ToNumber(space).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [type-excluded] coerces space: declared string | number
  - site: Set space to ? ToString(space).
  - why: If arg is a Symbol, throw a TypeError exception.
- [review] unbucketed root op SerializeJSONProperty
  - site: Return ? SerializeJSONProperty(state, the empty String, wrapper).
  - why: If value is a BigInt, throw a TypeError exception.

## `String.prototype.repeat` — **REVIEW**
- lib: es2015.core · spec: `String.prototype.repeat ( count )`
- [type-excluded] receiver is the declaring interface (non-nullable)
  - site: Perform ? RequireObjectCoercible(thisValue).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [review] coerces a value not traceable to a declared parameter
  - site: Let string be ? ToString(thisValue).
  - why: If arg is a Symbol, throw a TypeError exception.
- [type-excluded] coerces count: declared number
  - site: Let n be ? ToIntegerOrInfinity(count).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [review] explicit throw with a value-dependent condition
  - site: If n < 0 or n = +∞, throw a RangeError exception.
  - why: If n < 0 or n = +∞, throw a RangeError exception.

## `String.prototype.split` — proposed group 2
- lib: es5, es2015.symbol.wellknown · spec: `String.prototype.split ( separator, limit )`
- [type-excluded] receiver is the declaring interface (non-nullable)
  - site: Perform ? RequireObjectCoercible(thisValue).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [review] invokes user code with no callable parameter in the signature
  - site: Let splitter be ? GetMethod(separator, %Symbol.split%).
  - why: If IsCallable(func) is false, throw a TypeError exception.
- [review] invokes user code with no callable parameter in the signature
  - site: Return ? Call(splitter, separator, « thisValue, limit »).
  - why: If IsCallable(func) is false, throw a TypeError exception.
- [review] coerces a value not traceable to a declared parameter
  - site: Let string be ? ToString(thisValue).
  - why: If arg is a Symbol, throw a TypeError exception.
- [type-excluded] coerces limit: declared number
  - site: If limit is undefined, let lim be 232 - 1; else let lim be ℝ(? ToUint32(limit)).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [type-reachable] coerces separator: declared string | RegExp admits Symbol/BigInt/objects
  - site: Let separatorString be ? ToString(separator).
  - why: If arg is a Symbol, throw a TypeError exception.

## `Math.max` — proposed group 1
- lib: es5 · spec: `Math.max ( ...args )`
- [type-excluded] coerces values: declared number[]
  - site: Let n be ? ToNumber(arg).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.

## `Number.prototype.toFixed` — **REVIEW**
- lib: es5 · spec: `Number.prototype.toFixed ( fractionDigits )`
- [type-excluded] brand check discharged by the declared receiver type
  - site: Let number be ? ThisNumberValue(this value).
  - why: Throw a TypeError exception.
- [type-excluded] coerces fractionDigits: declared number
  - site: Let fractionCount be ? ToIntegerOrInfinity(fractionDigits).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [review] explicit throw with a value-dependent condition
  - site: If fractionCount is not finite, throw a RangeError exception.
  - why: If fractionCount is not finite, throw a RangeError exception.
- [review] explicit throw with a value-dependent condition
  - site: If fractionCount < 0 or fractionCount > 100, throw a RangeError exception.
  - why: If fractionCount < 0 or fractionCount > 100, throw a RangeError exception.

## `Map.prototype.get` — proposed group 1
- lib: es2015.collection · spec: `Map.prototype.get ( key )`
- [type-excluded] brand check discharged by the declared receiver type
  - site: Perform ? RequireInternalSlot(map, [[MapData]]).
  - why: If obj is not an Object, throw a TypeError exception.

## `Set.prototype.has` — proposed group 1
- lib: es2015.collection · spec: `Set.prototype.has ( value )`
- [type-excluded] brand check discharged by the declared receiver type
  - site: Perform ? RequireInternalSlot(set, [[SetData]]).
  - why: If obj is not an Object, throw a TypeError exception.

## `Promise.all` — **REVIEW**
- lib: es2015.iterable, es2015.promise · spec: `Promise.all ( iterable )`
- [review] unbucketed root op NewPromiseCapability
  - site: Let promiseCapability be ? NewPromiseCapability(ctor).
  - why: If IsConstructor(ctor) is false, throw a TypeError exception.

## `Array.from` — proposed group 2
- lib: es2015.core, es2015.iterable · spec: `Array.from ( items [ , mapper [ , thisArg ] ] )`
- [review] callability guard, param not clearly callable in lib.d.ts
  - site: If IsCallable(mapper) is false, throw a TypeError exception.
  - why: If IsCallable(mapper) is false, throw a TypeError exception.
- [review] invokes user code with no callable parameter in the signature
  - site: Let usingIterator be ? GetMethod(items, %Symbol.iterator%).
  - why: If IsCallable(func) is false, throw a TypeError exception.
- [review] invokes user code with no callable parameter in the signature
  - site: Let array be ? Construct(ctor).
  - why: [[Construct]] ( argList, newTarget ): If result.[[Value]] is not undefined, throw a TypeError exception.
- [review] drives a user-supplied iterator
  - site: Let iteratorRecord be ? GetIteratorFromMethod(items, usingIterator).
  - why: If iterator is not an Object, throw a TypeError exception.
- [review] drives a user-supplied iterator
  - site: Return ? IteratorClose(iteratorRecord, error).
  - why: If innerResult.[[Value]] is not an Object, throw a TypeError exception.
- [review] drives a user-supplied iterator
  - site: Let next be ? IteratorStepValue(iteratorRecord).
  - why: Throw a TypeError exception.
- [type-reachable] mutates the receiver; frozen/sealed is type-conformant
  - site: Perform ? Set(array, "length", 𝔽(k), true).
  - why: If success is false and throw is true, throw a TypeError exception.
- [type-reachable] coerces arrayLike: declared ArrayLike<T> admits Symbol/BigInt/objects
  - site: Let length be ? LengthOfArrayLike(arrayLike).
  - why: If arg is either a Symbol or a BigInt, throw a TypeError exception.
- [review] invokes user code with no callable parameter in the signature
  - site: Let array be ? Construct(ctor, « 𝔽(length) »).
  - why: [[Construct]] ( argList, newTarget ): If result.[[Value]] is not undefined, throw a TypeError exception.
- [review] unbucketed root op ArrayCreate
  - site: Let array be ? ArrayCreate(length).
  - why: If length > 232 - 1, throw a RangeError exception.
- [trust-base] property access: accessors / Proxy traps are invisible to the type system
  - site: Let kValue be ? Get(arrayLike, propertyKey).
  - why: [[Get]] ( propertyKey, receiver ): If targetEnv is empty, throw a ReferenceError exception.
- [review] invokes user code with no callable parameter in the signature
  - site: Let mappedValue be ? Call(mapper, thisArg, « kValue, 𝔽(k) »).
  - why: If IsCallable(func) is false, throw a TypeError exception.
- [type-reachable] mutates the receiver; frozen/sealed is type-conformant
  - site: Perform ? CreateDataPropertyOrThrow(array, propertyKey, mappedValue).
  - why: If success is false, throw a TypeError exception.
- [type-reachable] mutates the receiver; frozen/sealed is type-conformant
  - site: Perform ? Set(array, "length", 𝔽(length), true).
  - why: If success is false and throw is true, throw a TypeError exception.

## `String.prototype.padStart` — proposed group 1
- lib: es2017.string · spec: `String.prototype.padStart ( maxLength [ , fillString ] )`
- [type-excluded] receiver is the declaring interface (non-nullable)
  - site: Perform ? RequireObjectCoercible(thisValue).
  - why: If arg is either undefined or null, throw a TypeError exception.
- [type-excluded] coerces maxLength: declared number
  - site: Return ? StringPaddingBuiltinsImpl(thisValue, maxLength, fillString, start).
  - why: If arg is a Symbol, throw a TypeError exception.
