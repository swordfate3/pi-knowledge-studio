// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import type { Profile } from "../core/types.ts";

export const GENERAL_PROFILE: Profile = {
  id: "general",
  name: "General documents",
  description:
    "Neutral document understanding without domain-specific assumptions.",
  terminology: [],
  explanationGuidance:
    "Separate observations from interpretation, cite the source locator, and state uncertainty explicitly.",
  documentTemplate: "evidence-first",
};

export const FREERTOS_STM32_PROFILE: Profile = {
  id: "freertos-stm32",
  name: "FreeRTOS / STM32",
  description:
    "A demonstration profile for embedded RTOS learning; it does not change the core data model.",
  terminology: [
    "task",
    "scheduler",
    "queue",
    "semaphore",
    "mutex",
    "PendSV",
    "SysTick",
  ],
  explanationGuidance:
    "Distinguish task scheduling from interrupt handling, cite chapter/page, and do not infer register behavior without evidence.",
  documentTemplate: "evidence-first",
};

const BUILT_INS = new Map<string, Profile>([
  [GENERAL_PROFILE.id, GENERAL_PROFILE],
  [FREERTOS_STM32_PROFILE.id, FREERTOS_STM32_PROFILE],
]);

export function getProfile(id: string | undefined): Profile {
  return (
    BUILT_INS.get(id?.trim().toLowerCase() || "general") ?? GENERAL_PROFILE
  );
}

export function listProfiles(): Profile[] {
  return [...BUILT_INS.values()];
}
