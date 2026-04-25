export function withCallTracking(obj, methodName) {
  const calls = [];
  const original = obj[methodName];
  obj[methodName] = async (...args) => {
    calls.push(args);
    return original.apply(obj, args);
  };
  return { obj, calls };
}
