import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'webrtc-polyfill' && process.env.TORLNK_PLUS_WEBRTC !== '1') return { url: new URL('./webrtc-stub.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
