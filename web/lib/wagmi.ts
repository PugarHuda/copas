import { http, createConfig } from "wagmi";
import { monad, monadTestnet } from "./chains";

// ponytail: no injected-wallet connectors; login is Mera passkey (lib/mera). wagmi is used for reads only.
export const wagmiConfig = createConfig({
  chains: [monad, monadTestnet],
  transports: { [monad.id]: http(), [monadTestnet.id]: http() },
  ssr: true,
});
