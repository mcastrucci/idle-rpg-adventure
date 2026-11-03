export interface WorldMapPosition {
  x: number;
  y: number;
}

/** Presentation-safe projection. Hidden places are omitted entirely by the producer. */
export interface WorldMapView {
  hub: {
    id: string;
    label: string;
    position: WorldMapPosition | null;
  };
  areas: readonly {
    id: string;
    label: string;
    visibility: 'known' | 'locked';
    position: WorldMapPosition | null;
    /** Localized, safe-to-display reasons for a visible locked area. */
    lockedReasons: readonly string[];
    completion?: {
      complete: number;
      required: number;
      completed: boolean;
    };
    idleAvailable?: boolean;
    /** Adapter-supplied, user-facing copy such as danger or objective summaries. */
    details?: readonly string[];
    /** Short adapter-supplied status labels. */
    badges?: readonly string[];
    actions: {
      enter: boolean;
      startIdle: boolean;
    };
  }[];
  routes: readonly {
    id: string;
    from: string;
    to: string;
  }[];
  /** Coordinate system used by authored positions. Defaults to 1000 × 620. */
  size?: {
    width: number;
    height: number;
  };
}
