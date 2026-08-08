import increment, { Service } from "fielded";

declare const service: Service;

/** @nothrow */
export function run(): number {
  return increment(1) + service.handle(2) + Service.make().handle(3);
}
