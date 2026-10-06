/**
 * resolver.ts 行为测试：BFS 依赖解析、可选依赖、环检测、深度上限、冲突检查。
 * 全部离线——VersionSource 用内存假数据实现。
 */
import { describe, expect, it } from 'vitest'
import { MAX_RESOLVE_DEPTH, checkConflicts, resolveDependencies, type VersionSource } from '../src/resolver.js'
import type { ModrinthProject, ModrinthVersion, VersionFilter } from '../src/modrinth.js'

interface GraphNode {
  projectId: string
  slug: string
  title: string
  versionId: string
  dependencies: Array<{ projectId?: string; versionId?: string; dependencyType: string }>
  environment?: string
  loaders?: string[]
  gameVersions?: string[]
}

function makeVersion(node: GraphNode): ModrinthVersion {
  return {
    id: node.versionId,
    projectId: node.projectId,
    name: `${node.title} 1.0.0`,
    versionNumber: '1.0.0',
    versionType: 'release',
    gameVersions: node.gameVersions ?? ['1.20.1'],
    loaders: node.loaders ?? ['fabric'],
    environment: node.environment ?? 'both',
    downloads: 1,
    datePublished: '2026-01-01T00:00:00Z',
    files: [
      {
        url: `https://cdn.example.test/${node.slug}-1.0.0.jar`,
        filename: `${node.slug}-1.0.0.jar`,
        primary: true,
        size: 1024,
        sha1: 'a'.repeat(40),
        sha512: 'b'.repeat(128),
      },
    ],
    dependencies: node.dependencies.map((dependency) => ({
      versionId: dependency.versionId ?? null,
      projectId: dependency.projectId ?? null,
      fileName: null,
      dependencyType: dependency.dependencyType as ModrinthVersion['dependencies'][number]['dependencyType'],
    })),
  }
}

function makeSource(nodes: GraphNode[]): VersionSource {
  const byProject = new Map(nodes.map((node) => [node.projectId, node]))
  const bySlug = new Map(nodes.map((node) => [node.slug, node]))
  const byVersion = new Map(nodes.map((node) => [node.versionId, node]))
  const lookup = (key: string): GraphNode | undefined => byProject.get(key) ?? bySlug.get(key) ?? byVersion.get(key)
  return {
    async getVersion(versionId: string) {
      const node = byVersion.get(versionId)
      if (node === undefined) throw new Error(`unknown version ${versionId}`)
      return makeVersion(node)
    },
    async getProjectVersions(idOrSlug: string, _filter: VersionFilter) {
      const node = lookup(idOrSlug)
      if (node === undefined) throw new Error(`unknown project ${idOrSlug}`)
      return [makeVersion(node)]
    },
    async getProject(idOrSlug: string): Promise<ModrinthProject> {
      const node = lookup(idOrSlug)
      if (node === undefined) throw new Error(`unknown project ${idOrSlug}`)
      return {
        id: node.projectId,
        slug: node.slug,
        title: node.title,
        description: '',
        body: '',
        projectType: 'mod',
        categories: [],
        loaders: ['fabric'],
        gameVersions: ['1.20.1'],
        downloads: 0,
        followers: 0,
        license: 'MIT',
        clientSide: 'required',
        serverSide: 'unsupported',
        sourceUrl: null,
        issuesUrl: null,
        wikiUrl: null,
        discordUrl: null,
        iconUrl: null,
        published: null,
        updated: null,
        url: `https://modrinth.com/mod/${node.slug}`,
      }
    },
  }
}

describe('resolveDependencies', () => {
  it('递归展开必需依赖并按深度给出安装顺序', async () => {
    const nodes: GraphNode[] = [
      { projectId: 'P1', slug: 'alpha', title: 'Alpha', versionId: 'V1', dependencies: [{ projectId: 'P2', dependencyType: 'required' }, { projectId: 'P3', dependencyType: 'optional' }] },
      { projectId: 'P2', slug: 'beta', title: 'Beta', versionId: 'V2', dependencies: [{ projectId: 'P3', dependencyType: 'required' }] },
      { projectId: 'P3', slug: 'gamma', title: 'Gamma', versionId: 'V3', dependencies: [] },
    ]
    const result = await resolveDependencies([{ id: 'alpha' }], makeSource(nodes), {
      gameVersion: '1.20.1',
      loader: 'fabric',
    })

    expect(result.nodes.map((node) => node.slug).sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(result.stats.skippedOptional).toBe(1) // Alpha 的可选依赖 gamma 被跳过
    const alpha = result.nodes.find((node) => node.slug === 'alpha')!
    const beta = result.nodes.find((node) => node.slug === 'beta')!
    const gamma = result.nodes.find((node) => node.slug === 'gamma')!
    expect(alpha.role).toBe('root')
    expect(alpha.depth).toBe(0)
    expect(beta.role).toBe('required')
    expect(beta.depth).toBe(1)
    expect(gamma.depth).toBe(2) // 由 beta 在深度 1 请求
    expect(gamma.requestedBy).toContain('beta')
    expect(result.installOrder[0]).toBe('P1')
  })

  it('includeOptional=true 时纳入可选依赖', async () => {
    const nodes: GraphNode[] = [
      { projectId: 'P1', slug: 'alpha', title: 'Alpha', versionId: 'V1', dependencies: [{ projectId: 'P2', dependencyType: 'optional' }] },
      { projectId: 'P2', slug: 'beta', title: 'Beta', versionId: 'V2', dependencies: [] },
    ]
    const result = await resolveDependencies([{ id: 'alpha' }], makeSource(nodes), {
      gameVersion: '1.20.1',
      loader: 'fabric',
      includeOptional: true,
    })
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes.find((node) => node.slug === 'beta')?.role).toBe('optional')
    expect(result.stats.skippedOptional).toBe(0)
  })

  it('检测循环依赖且不会无限递归', async () => {
    const nodes: GraphNode[] = [
      { projectId: 'P1', slug: 'alpha', title: 'Alpha', versionId: 'V1', dependencies: [{ projectId: 'P2', dependencyType: 'required' }] },
      { projectId: 'P2', slug: 'beta', title: 'Beta', versionId: 'V2', dependencies: [{ projectId: 'P1', dependencyType: 'required' }] },
    ]
    const result = await resolveDependencies([{ id: 'alpha' }], makeSource(nodes), {
      gameVersion: '1.20.1',
      loader: 'fabric',
    })
    expect(result.nodes).toHaveLength(2)
    expect(result.issues.some((issue) => issue.kind === 'cycle')).toBe(true)
    expect(result.stats.cycles).toBeGreaterThan(0)
  })

  it('深度超过 50 时截断并给出 depth-limit 问题', async () => {
    const nodes: GraphNode[] = []
    for (let i = 0; i < 60; i++) {
      nodes.push({
        projectId: `P${i}`,
        slug: `mod-${i}`,
        title: `Mod ${i}`,
        versionId: `V${i}`,
        dependencies: i < 59 ? [{ projectId: `P${i + 1}`, dependencyType: 'required' }] : [],
      })
    }
    const result = await resolveDependencies([{ id: 'mod-0' }], makeSource(nodes), {
      gameVersion: '1.20.1',
      loader: 'fabric',
    })
    expect(result.stats.maxDepthReached).toBeLessThanOrEqual(MAX_RESOLVE_DEPTH)
    expect(result.nodes.length).toBeLessThanOrEqual(MAX_RESOLVE_DEPTH + 1)
    expect(result.issues.some((issue) => issue.kind === 'depth-limit')).toBe(true)
  })

  it('版本不存在时记录 missing 而不是抛异常', async () => {
    const nodes: GraphNode[] = [
      { projectId: 'P1', slug: 'alpha', title: 'Alpha', versionId: 'V1', dependencies: [{ projectId: 'P404', dependencyType: 'required' }] },
    ]
    const result = await resolveDependencies([{ id: 'alpha' }], makeSource(nodes), {
      gameVersion: '1.20.1',
      loader: 'fabric',
    })
    expect(result.issues.some((issue) => issue.kind === 'missing')).toBe(true)
    expect(result.nodes).toHaveLength(1)
  })
})

describe('checkConflicts', () => {
  it('命中 Sodium × OptiFine 的社区规则并判为 conflict', () => {
    const nodes = [
      { slug: 'sodium', projectId: 'P1', title: 'Sodium', versionId: 'V1' },
      { slug: 'optifine', projectId: 'P2', title: 'OptiFine', versionId: 'V2' },
    ].map((item) => ({
      ...item,
      versionNumber: item.versionId,
      versionType: 'release',
      fileName: `${item.slug}.jar`,
      downloadUrl: '',
      sha1: '',
      size: 0,
      role: 'root' as const,
      depth: 0,
      requestedBy: ['test'],
      loaders: [],
      gameVersions: [],
      notes: [],
    }))
    const report = checkConflicts(nodes)
    expect(report.verdict).toBe('conflict')
    expect(report.knownPairs.some((pair) => pair.severity === 'error')).toBe(true)
  })

  it('干净组合返回 ok', () => {
    const nodes = [
      { slug: 'sodium', projectId: 'P1', title: 'Sodium', versionId: 'V1' },
      { slug: 'lithium', projectId: 'P2', title: 'Lithium', versionId: 'V2' },
    ].map((item) => ({
      ...item,
      versionNumber: item.versionId,
      versionType: 'release',
      fileName: `${item.slug}.jar`,
      downloadUrl: '',
      sha1: '',
      size: 0,
      role: 'root' as const,
      depth: 0,
      requestedBy: ['test'],
      loaders: [],
      gameVersions: [],
      notes: [],
    }))
    expect(checkConflicts(nodes).verdict).toBe('ok')
  })
})
