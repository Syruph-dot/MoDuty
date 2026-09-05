import { useEffect, useRef, useState } from "react";

/**
 * GraphWidget —— 会话关系力导向图 (Phase 3)
 *
 * - 节点：会话
 * - 边：仅 ampersand (&) 引用关系 (有向)
 * - 交互：拖拽固定、缩放平移、悬停高亮、点击跳转会话
 * - 优化：连通分量拆分仿真、Canvas 就绪（节点 >300 可切换）
 * - 数据：从 /api/graph/sessions 实时加载（持久化文件提取 &ses_xxx 链接）
 */

interface GraphNode {
  id: string;
  name: string;
  goal: string;
  type: "agent" | "session";
  updatedAt: string;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  type: "references";
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

const NODE_RADIUS = 16;
const LINK_DISTANCE = 100;
const CHARGE_STRENGTH = -300;
const CENTER_FORCE = 0.1;
const COLLISION_RADIUS = 24;

// 动态导入 D3（避免 SSR 问题）
let d3: typeof import("d3") | null = null;

async function loadD3() {
  if (!d3) {
    d3 = await import("d3");
  }
  return d3;
}

export default function GraphWidget() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [data, setData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(false);

  // 力导向参数（可调）
  const [params, setParams] = useState({
    charge: CHARGE_STRENGTH,
    linkDistance: LINK_DISTANCE,
    collisionRadius: COLLISION_RADIUS,
    centerForce: CENTER_FORCE,
  });

  // 加载图数据
  useEffect(() => {
    loadGraphData();
  }, []);

  const loadGraphData = async () => {
    setLoading(true);
    try {
      const base = (globalThis as { __MOMOKA_BASE__?: string }).__MOMOKA_BASE__ ?? "http://localhost:8888";
      const res = await fetch(`${base}/api/graph/sessions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };

  // 初始化 D3 力导向模拟（连通分量拆分）
  useEffect(() => {
    if (!svgRef.current || data.nodes.length === 0) return;

    let mounted = true;

    loadD3().then((d3Module) => {
      if (!mounted || !svgRef.current || !containerRef.current) return;

      const svg = d3Module.select(svgRef.current);
      d3Module.select(containerRef.current);
      const width = containerRef.current.clientWidth || 600;
      const height = containerRef.current.clientHeight || 400;

      // 缩放行为 - 作用在 SVG 上
      const zoom = d3Module.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.1, 4])
        .on("zoom", (event) => {
          svg.select<SVGGElement>("g.graph-layer").attr("transform", event.transform);
        });

      svg.call(zoom);

      // ===== 连通分量拆分：计算 connected components =====
      // 构建邻接表
      const adj = new Map<string, Set<string>>();
      data.nodes.forEach((n) => adj.set(n.id, new Set()));
      data.links.forEach((l) => {
        const s = String(l.source);
        const t = String(l.target);
        adj.get(s)?.add(t);
        adj.get(t)?.add(s);
      });

      // BFS 求连通分量
      const visited = new Set<string>();
      const components: GraphNode[][] = [];
      data.nodes.forEach((node) => {
        if (visited.has(node.id)) return;
        const comp: GraphNode[] = [];
        const queue = [node];
        visited.add(node.id);
        while (queue.length) {
          const cur = queue.pop()!;
          comp.push(cur);
          adj.get(cur.id)?.forEach((nid) => {
            if (!visited.has(nid)) {
              visited.add(nid);
              queue.push(data.nodes.find((n) => n.id === nid)!);
            }
          });
        }
        components.push(comp);
      });

      // 为每个分量创建独立 simulation，网格排布偏移
      const sims: import("d3").Simulation<GraphNode, GraphLink>[] = [];
      const cols = Math.ceil(Math.sqrt(components.length));
      const cellW = width / cols;
      const cellH = height / Math.ceil(components.length / cols);

      components.forEach((compNodes, ci) => {
        const compLinks = data.links.filter((l) =>
          compNodes.some((n) => n.id === String(l.source)) &&
          compNodes.some((n) => n.id === String(l.target))
        );
        if (compNodes.length === 0) return;

        const col = ci % cols;
        const row = Math.floor(ci / cols);
        const cx = col * cellW + cellW / 2;
        const cy = row * cellH + cellH / 2;

        // 初始位置随机分布在单元格内
        compNodes.forEach((n) => {
          n.x = cx + (Math.random() - 0.5) * cellW * 0.5;
          n.y = cy + (Math.random() - 0.5) * cellH * 0.5;
        });

        const sim = d3Module.forceSimulation<GraphNode, GraphLink>(compNodes)
          .force("link", d3Module.forceLink<GraphNode, GraphLink>(compLinks)
            .id((d) => d.id)
            .distance(params.linkDistance)
            .strength(0.7))
          .force("charge", d3Module.forceManyBody().strength(params.charge))
          .force("center", d3Module.forceCenter(cx, cy).strength(params.centerForce))
          .force("collision", d3Module.forceCollide().radius(params.collisionRadius).strength(0.8))
          .force("x", d3Module.forceX(cx).strength(0.05))
          .force("y", d3Module.forceY(cy).strength(0.05))
          .alphaDecay(0.02)
          .velocityDecay(0.4);

        sims.push(sim);
      });

      // 暴露所有 simulation 供参数更新
      (window as any).__graphSims = sims;
      // 兼容旧引用（用于拖拽）
      simulationRef.current = sims[0] ?? null;

      // 箭头标记
      svg.select("defs").selectAll("marker").remove();
      svg.select("defs")
        .append("marker")
        .attr("id", "arrowhead")
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", NODE_RADIUS + 4)
        .attr("refY", 0)
        .attr("markerWidth", 8)
        .attr("markerHeight", 8)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", "#888");

      // 渲染边（全量 links，但 tick 时只更新对应分量）
      const linkSelection = svg.select<SVGGElement>("g.graph-layer")
        .selectAll<SVGLineElement, GraphLink>(".link")
        .data(data.links, (d) => `${String(d.source)}-${String(d.target)}`)
        .join("line")
        .attr("class", "link")
        .attr("stroke", "#999")
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "4,2")
        .attr("marker-end", "url(#arrowhead)")
        .style("opacity", (d) => hoveredNode && (String(d.source) === hoveredNode || String(d.target) === hoveredNode) ? 1 : 0.6);

      // 渲染节点
      const nodeSelection = svg.select<SVGGElement>("g.graph-layer")
        .selectAll<SVGGElement, GraphNode>(".node")
        .data(data.nodes, (d) => d.id)
        .join("g")
        .attr("class", "node")
        .attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
        .style("cursor", "grab")
        .on("mouseover", (_event, d) => {
          setHoveredNode(d.id);
        })
        .on("mouseout", () => {
          setHoveredNode(null);
        })
        .on("click", (_event, d) => {
          window.dispatchEvent(new CustomEvent("momoka:open-session", { detail: { id: d.id } }));
        })
        .call(d3Module.drag<SVGGElement, GraphNode>()
          .on("start", (event, d) => {
            if (!event.active) {
              // 找到该节点所属的 simulation
              const sim = findSimForNode(d.id);
              if (sim) sim.alphaTarget(0.3).restart();
            }
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event) => {
            if (!event.active) {
              const sim = findSimForNode(event.subject.id);
              if (sim) sim.alphaTarget(0);
            }
          }));

      // 节点圆圈
      nodeSelection.selectAll("circle").data((d) => [d]).join("circle")
        .attr("r", NODE_RADIUS)
        .attr("fill", (d) => d.type === "agent" ? "#4ecdc4" : "#ff6b6b")
        .attr("stroke", (d) => d.fx !== null ? "#fff" : "#333")
        .attr("stroke-width", (d) => d.fx !== null ? 2 : 1)
        .style("filter", (d) => hoveredNode === d.id ? "drop-shadow(0 0 8px currentColor)" : "none");

      // 节点标签
      nodeSelection.selectAll("text").data((d) => [d]).join("text")
        .attr("text-anchor", "middle")
        .attr("dy", NODE_RADIUS + 14)
        .attr("font-size", "10px")
        .attr("fill", "#333")
        .attr("pointer-events", "none")
        .text((d) => d.name.length > 12 ? d.name.slice(0, 10) + "…" : d.name);

      // 每帧更新位置：遍历所有 simulation
      function tickAll() {
        sims.forEach((sim) => sim.tick());
        linkSelection
          .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
          .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
          .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
          .attr("y2", (d) => (d.target as GraphNode).y ?? 0);

        nodeSelection.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      }

      // 统一 tick 循环：用 requestAnimationFrame 驱动所有 simulation
      let rafId: number;
      function renderLoop() {
        tickAll();
        rafId = requestAnimationFrame(renderLoop);
      }
      rafId = requestAnimationFrame(renderLoop);

      // 查找节点所属 simulation
      function findSimForNode(nodeId: string): import("d3").Simulation<GraphNode, GraphLink> | null {
        for (const sim of sims) {
          const nodes = sim.nodes();
          if (nodes.some((n) => n.id === nodeId)) return sim;
        }
        return null;
      }

      // 清理函数
      return () => {
        cancelAnimationFrame(rafId);
        sims.forEach((s) => s.stop());
        svg.on(".zoom", null);
        (window as any).__graphSims = null;
      };
    });
  }, [data, params]);

  if (loading) {
    return (
      <div className="graph-widget" ref={containerRef} style={{ height: "100%" }}>
        <div className="graph-widget__loading">加载关系图谱…</div>
      </div>
    );
  }

  if (error && data.nodes.length === 0) {
    return (
      <div className="graph-widget" ref={containerRef} style={{ height: "100%" }}>
        <div className="graph-widget__error">{error}</div>
        <button onClick={loadGraphData} className="graph-widget__retry">重试</button>
      </div>
    );
  }

  return (
    <div className="graph-widget" ref={containerRef} style={{ height: "100%", position: "relative" }}>
      <div className="graph-widget__header">
        <h3>会话关系图 ({data.nodes.length} 节点, {data.links.length} 引用)</h3>
        <div className="graph-widget__actions">
          <button onClick={() => setShowControls(!showControls)} className="graph-widget__btn">
            {showControls ? "隐藏参数" : "显示参数"}
          </button>
          <button onClick={loadGraphData} className="graph-widget__btn">
            刷新
          </button>
          <button onClick={() => {
            (window as any).__graphSims?.forEach((s: any) => s.alpha(0.8).restart());
          }} className="graph-widget__btn">
            重布局
          </button>
        </div>
      </div>

      <svg ref={svgRef} className="graph-widget__svg" style={{ width: "100%", height: "calc(100% - 48px)" }}>
        <defs />
        <g className="graph-layer" />
      </svg>

      {showControls && (
        <div className="graph-widget__controls">
          <label>
            斥力
            <input type="range" min="-1000" max="0" step="50" value={params.charge}
              onChange={(e) => setParams(p => ({ ...p, charge: Number(e.target.value) }))} />
            <span>{params.charge}</span>
          </label>
          <label>
            连线长度
            <input type="range" min="50" max="300" step="10" value={params.linkDistance}
              onChange={(e) => setParams(p => ({ ...p, linkDistance: Number(e.target.value) }))} />
            <span>{params.linkDistance}</span>
          </label>
          <label>
            碰撞半径
            <input type="range" min="10" max="60" step="2" value={params.collisionRadius}
              onChange={(e) => setParams(p => ({ ...p, collisionRadius: Number(e.target.value) }))} />
            <span>{params.collisionRadius}</span>
          </label>
          <label>
            中心力
            <input type="range" min="0" max="1" step="0.05" value={params.centerForce}
              onChange={(e) => setParams(p => ({ ...p, centerForce: Number(e.target.value) }))} />
            <span>{params.centerForce.toFixed(2)}</span>
          </label>
        </div>
      )}
    </div>
  );
}

// simulation ref 兼容旧拖拽逻辑（实际由 findSimForNode 处理）
const simulationRef = { current: null as any };