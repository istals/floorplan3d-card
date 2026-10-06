// Demo layout: a made-up two-storey house, 12 x 9 m, with a terrace and a garden.
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

export const DEMO_LAYOUT = {
  version: 1,
  floors: [],
  rooms: [
    { id: 'r-living', area_id: 'living_room', polygon: rect(0, 0, 5, 5), doors: [[5, 2.5], [2.5, 0]] },
    { id: 'r-hall', area_id: 'hall', polygon: rect(5, 0, 7.5, 5), doors: [[6.25, 0], [7.5, 3.8], [6.25, 5]] },
    { id: 'r-kitchen', area_id: 'kitchen', polygon: [[7.5, 0], [12, 0], [12, 5], [9.5, 5], [9.5, 6.5], [7.5, 6.5]], doors: [[7.5, 3.8]] },
    { id: 'r-bath', area_id: 'bathroom', polygon: rect(5, 5, 7.5, 9), doors: [[6.25, 5]] },
    { id: 'r-bed', area_id: 'bedroom', polygon: rect(0, 5, 5, 9), doors: [[4.2, 5]] },
    { id: 'r-utility', area_id: 'utility', polygon: [[9.5, 5], [12, 5], [12, 9], [7.5, 9], [7.5, 6.5], [9.5, 6.5]], doors: [[12, 7]] },
    { id: 'r-terrace', area_id: 'terrace', polygon: rect(0, -3, 5, 0), outdoor: true },
    { id: 'r-garden', area_id: 'garden', polygon: [[12, -7], [21, -7], [21, 10], [12, 10]], outdoor: true },

    { id: 'r-kids', area_id: 'kids_room', polygon: rect(0, 0, 5, 4.5), doors: [[5, 2.5]] },
    { id: 'r-landing', area_id: 'landing', polygon: rect(5, 0, 7.5, 9), doors: [[7.5, 2.5], [7.5, 7], [5, 6.5]] },
    { id: 'r-office', area_id: 'office', polygon: rect(7.5, 0, 12, 5), doors: [] },
    { id: 'r-master', area_id: 'master_bedroom', polygon: rect(0, 4.5, 5, 9), doors: [] },
    { id: 'r-bath2', area_id: 'bathroom_2', polygon: rect(7.5, 5, 12, 9), doors: [] },
  ],
  pins: {
    // the floor lamp stands in the living room corner, not on the ceiling
    'device:floor_lamp': { x: 0.6, y: 4.3, z: 1.5, floor_id: 'ground' },
  },
  hidden: [],
  // the facade lamps (one group in demo/house.glb) also need the facade switch on
  tags: { facade: { entity: 'switch.demo_facade' } },
  mower: {
    entity: 'device_tracker.sunseeker_position',
    source: 'gps',
    floor_id: 'ground',
    error_entity: 'binary_sensor.demo_mower_error',
    stuck_minutes: 5,
    // garden centre (16.5, 1.5); second point 4 m north of it
    calibration: [
      { src: [45.0, 10.0], plan: [16.5, 1.5] },
      { src: [45.0 + 4 / 111320, 10.0], plan: [16.5, 5.5] },
    ],
    overlay: { entity: 'image.sunseeker_map', x: 16.5, y: 1.5, rotation: 0, width: 9, opacity: 0.55, refresh: 10 },
    trail: true,
  },
};
