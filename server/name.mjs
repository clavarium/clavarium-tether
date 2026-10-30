/* THE NAME, IN ONE PLACE. The product may be renamed: everything that says it
 * (the command, the MCP server, the agent's folder, the environment variables,
 * the default store, the page title, the tmux socket) reads it from here.
 * Outside this file only package.json, README.md, LICENSE and docs/ spell it.
 */
export const NAME = 'tether';
export const PRODUCT = 'Clavarium Tether';
export const PACKAGE = `clavarium-${NAME}`;
export const VERSION = '0.1.0-next.30';
/* The agent's folder: where its asks and the keeper's answers are written. */
export const FOLDER = `.${NAME}`;
/* $TETHER_DIR: the agent's folder; $TETHER_STORE: the keeper's store (serve). */
export const ENV_DIR = `${NAME.toUpperCase()}_DIR`;
export const ENV_STORE = `${NAME.toUpperCase()}_STORE`;
