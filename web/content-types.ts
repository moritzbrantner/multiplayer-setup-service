import type { TypedEventTarget, ContentData } from "./events.ts";
export type ContentEvents = {
  content: {peerId: string; data: ContentData};
  "content-peer-closed": {peerId: string; connectionId: string};
  "content-peer-ready": {peerId: string; connectionId: string};
  "peer-created": {peerId: string; connectionId: string; initiatedLocally: boolean};
  error: {peerId: string; error: unknown};
};
export type ContentTransport = Pick<TypedEventTarget<ContentEvents>, "addEventListener" | "removeEventListener"> & {
  contentSharing: boolean;
  sendContent: (peerId: string, data: ContentData) => Promise<void>;
  contentPeerIds: () => string[];
};
