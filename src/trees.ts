/**
 * Flat gradient-boosted tree inference shared by the candidate selector and
 * the block classifier (models exported from sklearn by the benchmark
 * training scripts).
 *
 * @module dsh-web-fetch-playwright/trees
 */

/** One tree in flat array form (sklearn layout: leaf when left === -1). */
export interface FlatTree {
  feature: number[]
  threshold: number[]
  left: number[]
  right: number[]
  value: number[]
}

/** Any additive tree ensemble: `init + learningRate * Σ tree(x)`. */
export interface TreeEnsemble {
  init: number
  learningRate: number
  trees: FlatTree[]
  /** Compare in float64 (HistGradientBoosting) instead of sklearn trees' float32. */
  float64?: boolean
}

function predictTree(tree: FlatTree, x: number[], float64: boolean): number {
  let node = 0
  while (tree.left[node] !== -1) {
    const feature = tree.feature[node] ?? 0
    // sklearn compares features as float32; mirror that so split boundaries agree.
    const value = x[feature] ?? 0
    node = (float64 ? value : Math.fround(value)) <= (tree.threshold[node] ?? 0) ? tree.left[node] ?? 0 : tree.right[node] ?? 0
  }
  return tree.value[node] ?? 0
}

/** Raw ensemble output for one feature vector. */
export function predictTrees(model: TreeEnsemble, x: number[]): number {
  let sum = model.init
  for (const tree of model.trees) sum += model.learningRate * predictTree(tree, x, model.float64 === true)
  return sum
}
