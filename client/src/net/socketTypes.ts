import type { ClientToServerEvents, ServerToClientEvents } from './contract';

/**
 * socket.io types each event as a listener function. The locked contract
 * stores the payload object instead, so map those payloads onto handlers.
 */
type ToHandler<Payload> = [Payload] extends [(...args: infer Args) => infer Result]
  ? (...args: Args) => Result
  : (payload: Payload) => void;

export type ServerListeners = {
  [EventName in keyof ServerToClientEvents]: ToHandler<ServerToClientEvents[EventName]>;
};

export type ClientEmitters = {
  [EventName in keyof ClientToServerEvents]: ToHandler<ClientToServerEvents[EventName]>;
};
