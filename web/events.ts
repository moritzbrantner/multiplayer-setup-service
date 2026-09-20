/** Typed application events. The cast is confined to the DOM EventTarget adapter. */
export class TypedEventTarget<Events extends object> extends EventTarget {
  override addEventListener<K extends keyof Events & string>(
    type: K, listener: ((event: CustomEvent<Events[K]>) => void) | null,
    options?: AddEventListenerOptions | boolean,
  ): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | ((event: never) => void) | null, options?: AddEventListenerOptions | boolean): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
  }
  override removeEventListener<K extends keyof Events & string>(
    type: K, listener: ((event: CustomEvent<Events[K]>) => void) | null,
    options?: EventListenerOptions | boolean,
  ): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | ((event: never) => void) | null, options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type Binary = ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob;
export type ContentData = Binary | string;
export type Timer = ReturnType<typeof setTimeout>;
