export type MessageType = "join" | "offer" | "answer" | "ice" | "pubkey" | "leave" | "error";

export interface Envelope {
  v: number;
  type: MessageType;
  room: string;
  token?: string;
  payload?: unknown;
}