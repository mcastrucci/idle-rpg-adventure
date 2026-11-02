import '../styles.css';

import { runHarness } from '../harness/harness.ts';
import { PixiSceneRenderer } from '../renderers/pixi.ts';

void runHarness(() => new PixiSceneRenderer());
