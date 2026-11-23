export interface Action {
  id: string;
  group: string;
  title: string;
  about: string;
  key: string;
  command: string;
  ask: string;
  askHint: string;
  strip: string;
  own?: boolean;
}
export const ACTIONS: Action[];
export function findAction(id: string): Action | null;
export function actionGroups(): { name: string; actions: Action[] }[];
export function quickReplies(sp: string, riding?: boolean): [string, string][];
