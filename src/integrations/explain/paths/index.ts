import { registerPath } from "../path_registry.js";
import { stablecoinLiquidity } from "./stablecoin_liquidity.js";
import { volumePriceDivergence } from "./volume_price_divergence.js";
import { multiSymbolSynchrony } from "./multi_symbol_synchrony.js";
import { singleSymbolLocal } from "./single_symbol_local.js";
import { repeatedBurstSequence } from "./repeated_burst_sequence.js";
import { baselineExtremePosition } from "./baseline_extreme_position.js";
import { systemHealthSuspect } from "./system_health_suspect.js";
import { knownNoisePattern } from "./known_noise_pattern.js";

export function registerDefaultPaths() {
  registerPath(stablecoinLiquidity);
  registerPath(volumePriceDivergence);
  registerPath(multiSymbolSynchrony);
  registerPath(singleSymbolLocal);
  registerPath(repeatedBurstSequence);
  registerPath(baselineExtremePosition);
  registerPath(systemHealthSuspect);
  registerPath(knownNoisePattern);
}
