import './player-sprites.css';

/** The two player designs, displayed together while the scene is being built. */
export function PlayerSprites() {
  return <div className="player-sprites" role="group" aria-label="Spellbearer character designs">
    <img src="/art/spellbearer-male.png" alt="Male spellbearer silhouette with short hair, scarf, and travel robes" draggable={false} />
    <img src="/art/spellbearer-female.png" alt="Female spellbearer silhouette with a long ponytail, scarf, and travel robes" draggable={false} />
  </div>;
}
