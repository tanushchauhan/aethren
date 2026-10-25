/** Typed server configuration read from the environment. */
const port = Number.parseInt(process.env.PORT ?? '', 10);

export const config = {
  port: Number.isFinite(port) && port > 0 ? port : 3001,
  /** Comma-separated allowed browser origins. Blank allows all (dev only). */
  clientOrigin:
    process.env.CLIENT_ORIGIN && process.env.CLIENT_ORIGIN.trim() !== ''
      ? process.env.CLIENT_ORIGIN.split(',').map((o) => o.trim())
      : true,
} as const;
