/** The deployment manifest this bundle serves, embedded at build time (`build/target.ts`). */
declare const __BRIDGE_MANIFEST__: unknown
/** The deployment's published users' tag. */
declare const __SHOWCASE_USERS_TAG__: string
/** The deployment's published merchants' salt; null only for a version-1 demo. */
declare const __SHOWCASE_MERCHANTS_SALT__: string | null
/** The public L1 RPC endpoint the page reads and sends through. */
declare const __SHOWCASE_L1_RPC__: string
declare const __SHOWCASE_PROOFS__: "real" | "fake"
/** Where the page looks for Presto (`build/target.ts`): the app's own ports, or a local test's presto-server. */
declare const __SHOWCASE_PRESTO__: { port: number; httpsPort: number }
/** The recording the page replays: the testnet's own acceptance run, or the local fixture. */
declare const __SHOWCASE_TOUR__: unknown
