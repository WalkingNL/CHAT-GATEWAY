import fs from "node:fs";
import YAML from "yaml";

export type Config = any;

export function loadConfig(path = "config.yaml"): Config {
  const raw = fs.readFileSync(path, "utf-8");
  return YAML.parse(raw);
}
