// Node has no `herdr` module: stand in a stub so providers.js can be imported outside the app.
import { register } from "node:module";
register("data:text/javascript,export async function resolve(s, c, next) { return s === 'herdr' ? { url: 'data:text/javascript,export const readTextFile = async () => null', shortCircuit: true } : next(s, c); }");
