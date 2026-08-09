import { widgets, type Widget } from "factoryish";

/** @nothrow */
export function construct(size: number): Widget {
  return new widgets(size);
}

/** @nothrow */
export function viaProperty(size: number): Widget {
  return widgets.new(size);
}
