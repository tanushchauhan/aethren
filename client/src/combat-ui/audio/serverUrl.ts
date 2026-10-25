import { DEFAULT_SERVER_URL } from '../../net/contract';

export function serverUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL;
  const raw = configured && configured.trim() ? configured.trim() : DEFAULT_SERVER_URL;
  return raw.replace(/\/$/, '');
}
