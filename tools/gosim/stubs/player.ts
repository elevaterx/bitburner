export const Player: any = {
  totalPlaytime: 1,
  factions: [],
  bitNodeN: 2,
  augmentations: [],
  queuedAugmentations: [],
  entropy: 0,
  mults: { crime_success: 1 },
  hasAugmentation: () => true,
  activeSourceFileLvl: () => 0,
  sourceFileLvl: () => 0,
  giveAchievement: () => {},
  applyEntropy: () => {},
  reapplyAllAugmentations: () => {},
};
export const setPlayer = () => {};
export const loadPlayer = () => {};
