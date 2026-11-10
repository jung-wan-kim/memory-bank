// `node --import <this file>`: every import of the Agent SDK in that process gets
// test/helpers/fake-agent-sdk.mjs instead (static, dynamic, and from CommonJS).
import { register } from 'node:module';

register('./fake-agent-sdk-hooks.mjs', import.meta.url);
