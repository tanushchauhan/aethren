import type { PlayerPublic, PlayerRole } from '../net/contract';

export function findLocalPlayer(
  players: readonly PlayerPublic[] | undefined,
  localPlayerId: string | null,
  localRole: PlayerRole | null,
): PlayerPublic | null {
  if (!players || players.length === 0) return null;
  if (localPlayerId) {
    const byId = players.find((player) => player.id === localPlayerId);
    if (byId) return byId;
  }
  if (localRole) {
    const byRole = players.find((player) => player.role === localRole);
    if (byRole) return byRole;
  }
  return null;
}
