/** Shared rain strokes for the title and story forest. */
export function drawRain(ctx: CanvasRenderingContext2D, width: number, height: number, elapsed: number) {
  ctx.strokeStyle = '#bad9e633'; ctx.lineWidth = .8;
  ctx.beginPath();
  for (let i = 0; i < 90; i++) {
    const y = ((i * 173 + elapsed * (420 + i % 4 * 90)) % (height + 80)) - 40;
    const x = ((i * 139 - elapsed * 70) % (width + 100) + width + 100) % (width + 100) - 50;
    ctx.moveTo(x, y); ctx.lineTo(x - 9, y + 26 + i % 5 * 3);
  }
  ctx.stroke();
}
