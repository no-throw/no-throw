export function twice(n) {
    return n * 2;
}
export async function fetchOk() {
    return 1;
}
export function each(items, visit) {
    for (let index = 0; index < items.length; index += 1) {
        visit(items[index]);
    }
}
export function widen(value) {
    return `${value}`;
}
let latest;
export function register(handler) {
    latest = handler;
}
export function latestHandler() {
    return latest;
}
export function isFlag(text) {
    return text.startsWith("--");
}
