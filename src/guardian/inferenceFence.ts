// Inference Guardian — Inference Fence
// Ensures only one model instance runs at a time and enforces resource budgets.

import type { FenceConfig, FenceStatus, CudaSnapshot, TrackedProcess } from './types.js';
import { DEFAULT_FENCE_CONFIG } from './types.js';

// ── State ──

let config: FenceConfig = { ...DEFAULT_FENCE_CONFIG };
let promptStartedAt: number | null = null;
let locked = false;

export function getConfig(): FenceConfig {
  return { ...config };
}

export function updateConfig(patch: Partial<FenceConfig>): FenceConfig {
  config = { ...config, ...patch };
  return { ...config };
}

export function resetFence(): void {
  promptStartedAt = null;
  locked = false;
}

export function markPromptStarted(): void {
  promptStartedAt = Date.now();
}

export function markPromptFinished(): void {
  promptStartedAt = null;
}

export function acquireLock(): boolean {
  if (locked) return false;
  locked = true;
  return true;
}

export function releaseLock(): void {
  locked = false;
}

/**
 * Evaluate fence constraints and return current fence status.
 */
export function evaluate(
  _processes: TrackedProcess[],
  cudaSnapshot: CudaSnapshot,
): FenceStatus {
  const now = Date.now();

  // Count active model workers (processes using >4GB VRAM)
  const activeModels = cudaSnapshot.processes.filter((p) => p.usedMemoryMb > 4000).length;

  // VRAM used by managed processes
  const managedVram = cudaSnapshot.processes
    .filter((p) => p.isManaged)
    .reduce((sum, p) => sum + p.usedMemoryMb, 0);

  const isOverBudget = managedVram > config.vramBudgetMb;

  // Prompt timeout check
  let promptTimedOut = false;
  if (promptStartedAt !== null) {
    const elapsed = now - promptStartedAt;
    if (elapsed > config.promptTimeoutMs) {
      promptTimedOut = true;
    }
  }

  return {
    activeModels,
    vramUsedMb: managedVram,
    vramBudgetMb: config.vramBudgetMb,
    isOverBudget,
    promptStartedAt,
    promptTimedOut,
    locked,
  };
}

/**
 * Check if launching a new model is allowed by fence rules.
 */
export function canLaunchModel(cudaSnapshot: CudaSnapshot): { allowed: boolean; reason?: string } {
  const activeModels = cudaSnapshot.processes.filter((p) => p.usedMemoryMb > 4000).length;

  if (activeModels >= config.maxConcurrentModels) {
    return {
      allowed: false,
      reason: `Already ${activeModels}/${config.maxConcurrentModels} model(s) loaded. Kill existing before launching another.`,
    };
  }

  if (locked) {
    return {
      allowed: false,
      reason: 'Fence is locked — another operation is in progress.',
    };
  }

  return { allowed: true };
}
