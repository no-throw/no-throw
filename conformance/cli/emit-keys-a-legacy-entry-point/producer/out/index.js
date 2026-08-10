export function clamp(value, max) {
    return value > max ? max : value;
}
export function parseOrThrow(text) {
    return JSON.parse(text);
}
