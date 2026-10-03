import { definePlugin } from '@altifigence/dds-plugin-sdk';
import manifest from './plugin.json' with {type: 'json'};

export default definePlugin(manifest, context => context.registerCommand({
  id: 'greet',
  title: 'Say hello',
  description: 'Return a greeting from the workspace plugin without reading project files.',
  parameters: [{name: 'name', label: 'Your name', type: 'string', required: true}],
}, (input, {signal}) => {
  signal.throwIfAborted();
  return {message: `Hello, ${input.name}!`, pluginId: context.pluginId};
}));
