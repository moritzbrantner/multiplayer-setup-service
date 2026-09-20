/** Resolve required markup once and fail at the UI boundary if it is missing. */
export function requiredElement<T extends Element>(selector: string, constructor: new () => T, root: ParentNode = document): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Required element is missing: ${selector}`);
  return element;
}
export function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D rendering is unavailable");
  return context;
}
