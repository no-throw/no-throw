type Handler = () => void;

/** @nothrow */
export const cast = ((): void => {
  throw "boom";
}) as Handler;

/** @nothrow */
export const checked = ((): void => {
  throw "boom";
}) satisfies Handler;
