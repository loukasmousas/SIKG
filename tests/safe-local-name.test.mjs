// safe-local-name.test.mjs
import { safeLocalName } from '../src/common/MetadataIndex.js';

const cases = {
  'Traffic Light': 'traffic_light', // spaces -> underscore
  'Café-au-lait!': 'cafaulait', // accents stripped, hyphens/punct removed (no extra underscore)
  αβγ: '', // non-latin removed entirely
  '🚗 car': '_car', // emoji removed leaving leading underscore from space replacement
  'multi   space  name': 'multi_space_name', // collapse multiple spaces
};
let failures = 0;
for (const [input, expected] of Object.entries(cases)) {
  const out = safeLocalName(input);
  if (out !== expected) {
    console.error('Mismatch', input, out, expected);
    failures++;
  }
}
if (failures) {
  process.exitCode = 1;
  console.error('safeLocalName test failed');
} else console.log('safeLocalName test passed.');
