import '../styles.css';

import { runHarness } from '../harness/harness.ts';
import { PhaserSceneRenderer } from '../renderers/phaser.ts';

void runHarness(() => new PhaserSceneRenderer());
