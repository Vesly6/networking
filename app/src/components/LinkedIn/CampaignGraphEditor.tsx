import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  Position,
  Handle,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Play, X } from 'lucide-react';
import { useLinkedInCampaignsStore } from '../../store/useLinkedInCampaignsStore';
import type { LinkedInSequenceNodeType } from '../../utils/linkedinCampaignsApi';
import { ACTION_NODE_TYPES, CONDITION_NODE_TYPES, NODE_TYPE_META, isConditionType } from '../../utils/linkedinNodeTypes';

const START_ID = '__start__';

interface ActionNodeData extends Record<string, unknown> {
  nodeType: LinkedInSequenceNodeType | '__start__';
  messageTemplate: string | null;
  waitDays: number | null;
  onFieldChange: (patch: { messageTemplate?: string | null; waitDays?: number | null }) => void;
  onDelete: () => void;
}

type FlowNode = Node<ActionNodeData>;

function ActionNodeView({ data }: NodeProps<FlowNode>) {
  const meta = data.nodeType === '__start__' ? null : NODE_TYPE_META[data.nodeType];
  const isStart = data.nodeType === '__start__';
  const isCondition = !isStart && isConditionType(data.nodeType as LinkedInSequenceNodeType);
  const needsMessage = data.nodeType === 'connect' || data.nodeType === 'message';
  const needsWaitDays = data.nodeType === 'wait';
  const needsTimeout = isCondition;

  const MetaIcon = meta?.icon;

  return (
    <div className={`linkedin-flow-node${isCondition ? ' linkedin-flow-node-condition' : ''}${isStart ? ' linkedin-flow-node-start' : ''}`}>
      {!isStart && <Handle type="target" position={Position.Top} />}
      <div className="linkedin-flow-node-header">
        <span>
          {isStart ? (
            <>
              <Play className="icon" size={16} /> Pradžia
            </>
          ) : (
            <>
              {MetaIcon && <MetaIcon className="icon" size={16} />} {meta?.label}
            </>
          )}
        </span>
        {!isStart && (
          <button type="button" className="linkedin-flow-node-delete" onClick={data.onDelete} title="Pašalinti mazgą">
            <X className="icon" size={14} />
          </button>
        )}
      </div>
      {meta && !meta.enabled && <div className="linkedin-flow-node-disabled">Netrukus — {meta.disabledReason}</div>}
      {needsMessage && (
        <textarea
          className="nodrag linkedin-flow-node-textarea"
          placeholder={data.nodeType === 'connect' ? 'Kvietimo tekstas (nebūtina)…' : 'Žinutės tekstas…'}
          value={data.messageTemplate ?? ''}
          onChange={(e) => data.onFieldChange({ messageTemplate: e.target.value })}
        />
      )}
      {needsWaitDays && (
        <label className="nodrag linkedin-flow-node-days">
          Dienos:
          <input
            type="number"
            min={0}
            value={data.waitDays ?? 0}
            onChange={(e) => data.onFieldChange({ waitDays: Number(e.target.value) || 0 })}
          />
        </label>
      )}
      {needsTimeout && (
        <label className="nodrag linkedin-flow-node-days" title='Kiek dienų laukti prieš pasirenkant "Ne" šaką, jei atsakymas dar neaiškus.'>
          Laukti (d.):
          <input
            type="number"
            min={0}
            value={data.waitDays ?? 0}
            onChange={(e) => data.onFieldChange({ waitDays: Number(e.target.value) || 0 })}
          />
        </label>
      )}
      {!isStart && !isCondition && data.nodeType !== 'end' && <Handle type="source" position={Position.Bottom} id="default" />}
      {isCondition && (
        <>
          <Handle type="source" position={Position.Bottom} id="yes" style={{ left: '25%' }} className="linkedin-flow-handle-yes" />
          <Handle type="source" position={Position.Bottom} id="no" style={{ left: '75%' }} className="linkedin-flow-handle-no" />
          <div className="linkedin-flow-node-branch-labels">
            <span className="linkedin-flow-branch-yes">Taip</span>
            <span className="linkedin-flow-branch-no">Ne</span>
          </div>
        </>
      )}
      {isStart && <Handle type="source" position={Position.Bottom} id="default" />}
    </div>
  );
}

const nodeTypes: NodeTypes = { flowNode: ActionNodeView };

let nodeCounter = 0;
function newNodeId(): string {
  nodeCounter += 1;
  return `n_${Date.now().toString(36)}_${nodeCounter}`;
}

function EditorInner({ campaignId }: { campaignId: string }) {
  const graphNodesDb = useLinkedInCampaignsStore((s) => s.graphNodes);
  const graphEdgesDb = useLinkedInCampaignsStore((s) => s.graphEdges);
  const graphReady = useLinkedInCampaignsStore((s) => s.graphReady);
  const refreshGraph = useLinkedInCampaignsStore((s) => s.refreshGraph);
  const saveGraph = useLinkedInCampaignsStore((s) => s.saveGraph);
  const savingGraph = useLinkedInCampaignsStore((s) => s.savingGraph);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const loadedRef = useRef(false);

  useEffect(() => {
    void refreshGraph(campaignId);
    loadedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  // Converts the server's DB shape into React Flow's node/edge shape once
  // per load — done only once (loadedRef), not on every store update,
  // since after the initial load this component's own local nodes/edges
  // state is the live source of truth (saveGraph's optimistic update
  // would otherwise fight with the user's own in-progress drag/edit).
  useEffect(() => {
    if (!graphReady || loadedRef.current) return;
    loadedRef.current = true;

    // The Start node's position is deliberately computed, not hardcoded to
    // (0,0) — a real, live-caught bug: migrateLegacySequenceStepsToGraph()
    // (server-side) also places a campaign's very first migrated node at
    // (0,0), so a hardcoded Start position landed EXACTLY on top of it —
    // same coordinates, fully overlapping, with the Start node completely
    // hidden underneath. Anchoring Start well above whatever the topmost
    // real node's y actually is (falling back to a plain default when
    // there are no nodes yet) keeps it visually separate regardless of
    // where migrated or manually-placed nodes end up.
    const topMostY = graphNodesDb.reduce((min, n) => Math.min(min, n.posY), 0);
    const startX = graphNodesDb.find((n) => n.posY === topMostY)?.posX ?? 0;

    const flowNodes: FlowNode[] = [
      {
        id: START_ID,
        type: 'flowNode',
        position: { x: startX, y: topMostY - 160 },
        data: { nodeType: '__start__', messageTemplate: null, waitDays: null, onFieldChange: () => {}, onDelete: () => {} },
        deletable: false,
      },
      ...graphNodesDb.map((n) => ({
        id: n.id,
        type: 'flowNode',
        position: { x: n.posX, y: n.posY },
        data: { nodeType: n.type, messageTemplate: n.messageTemplate, waitDays: n.waitDays, onFieldChange: () => {}, onDelete: () => {} },
      })),
    ];
    const flowEdges: Edge[] = graphEdgesDb.map((e) => ({
      id: e.id,
      source: e.fromNodeId ?? START_ID,
      target: e.toNodeId,
      sourceHandle: e.branch,
    }));
    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [graphReady, graphNodesDb, graphEdgesDb, setNodes, setEdges]);

  // Debounced autosave — any node/edge change (add, delete, rewire, drag,
  // field edit) schedules a save a moment later rather than firing one
  // request per keystroke/pixel of drag, same "batch, don't spam" reasoning
  // as every other bulk-save endpoint in this app.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback(
    (nextNodes: FlowNode[], nextEdges: Edge[]) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const payloadNodes = nextNodes
          .filter((n) => n.id !== START_ID)
          .map((n) => ({
            id: n.id,
            type: n.data.nodeType as LinkedInSequenceNodeType,
            messageTemplate: n.data.messageTemplate,
            waitDays: n.data.waitDays,
            posX: n.position.x,
            posY: n.position.y,
          }));
        const validNodeIds = new Set(payloadNodes.map((n) => n.id));
        const payloadEdges = nextEdges
          .filter((e) => validNodeIds.has(e.target) && (e.source === START_ID || validNodeIds.has(e.source)))
          .map((e) => ({
            fromNodeId: e.source === START_ID ? null : e.source,
            toNodeId: e.target,
            branch: (e.sourceHandle as 'default' | 'yes' | 'no' | null) ?? 'default',
          }));
        void saveGraph(campaignId, payloadNodes, payloadEdges);
      }, 900);
    },
    [campaignId, saveGraph],
  );

  const handleFieldChange = useCallback(
    (id: string, patch: { messageTemplate?: string | null; waitDays?: number | null }) => {
      setNodes((prev) => {
        const next = prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
        scheduleSave(next, edges);
        return next;
      });
    },
    [setNodes, scheduleSave, edges],
  );

  const handleDelete = useCallback(
    (id: string) => {
      setNodes((prev) => {
        const next = prev.filter((n) => n.id !== id);
        setEdges((prevEdges) => {
          const nextEdges = prevEdges.filter((e) => e.source !== id && e.target !== id);
          scheduleSave(next, nextEdges);
          return nextEdges;
        });
        return next;
      });
    },
    [setNodes, setEdges, scheduleSave],
  );

  // Every node's data.onFieldChange/onDelete is bound fresh each render to
  // its own id — cheap for a realistic graph size, and means the custom
  // node component never needs its own imperative escape hatch
  // (useReactFlow) to reach back into this component's state.
  const boundNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          onFieldChange: (patch: { messageTemplate?: string | null; waitDays?: number | null }) => handleFieldChange(n.id, patch),
          onDelete: () => handleDelete(n.id),
        },
      })),
    [nodes, handleFieldChange, handleDelete],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((prev) => {
        const next = addEdge(connection, prev);
        scheduleSave(nodes, next);
        return next;
      });
    },
    [setEdges, nodes, scheduleSave],
  );

  const handleNodesChangeWrapped: typeof onNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes);
      // Position changes (drag) need their own save trigger — onNodesChange
      // above updates React Flow's internal state asynchronously, so the
      // "next" nodes array for saving is read on the following tick via a
      // rAF-deferred read of the live `nodes` ref instead of relying on a
      // stale closure here.
      if (changes.some((c) => c.type === 'position' && c.dragging === false)) {
        requestAnimationFrame(() => scheduleSave(nodesRef.current, edgesRef.current));
      }
      if (changes.some((c) => c.type === 'remove')) {
        requestAnimationFrame(() => scheduleSave(nodesRef.current, edgesRef.current));
      }
    },
    [onNodesChange, scheduleSave],
  );

  // Refs mirroring live state — needed because scheduleSave (called from
  // rAF callbacks above, outside React's own batched update cycle) must
  // read the *current* nodes/edges, not whatever was captured in a
  // useCallback closure at render time.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const addNode = (type: LinkedInSequenceNodeType) => {
    const id = newNodeId();
    const maxY = nodes.reduce((m, n) => Math.max(m, n.position.y), 0);
    setNodes((prev) => {
      const next: FlowNode[] = [
        ...prev,
        {
          id,
          type: 'flowNode',
          position: { x: 100 + Math.random() * 200, y: maxY + 140 },
          data: { nodeType: type, messageTemplate: null, waitDays: type === 'wait' || isConditionType(type) ? 3 : null, onFieldChange: () => {}, onDelete: () => {} },
        },
      ];
      scheduleSave(next, edges);
      return next;
    });
  };

  return (
    <div className="linkedin-graph-editor">
      <div className="linkedin-graph-palette">
        <div className="linkedin-graph-palette-group">
          <span className="linkedin-graph-palette-label">Veiksmai</span>
          {ACTION_NODE_TYPES.map((m) => (
            <button
              key={m.type}
              type="button"
              disabled={!m.enabled}
              title={m.enabled ? undefined : m.disabledReason}
              onClick={() => addNode(m.type)}
            >
              <m.icon className="icon" size={16} /> {m.label}
              {!m.enabled && ' (netrukus)'}
            </button>
          ))}
        </div>
        <div className="linkedin-graph-palette-group">
          <span className="linkedin-graph-palette-label">Sąlygos</span>
          {CONDITION_NODE_TYPES.map((m) => (
            <button
              key={m.type}
              type="button"
              disabled={!m.enabled}
              title={m.enabled ? undefined : m.disabledReason}
              onClick={() => addNode(m.type)}
            >
              <m.icon className="icon" size={16} /> {m.label}
              {!m.enabled && ' (netrukus)'}
            </button>
          ))}
        </div>
        {savingGraph && <span className="linkedin-hint">Išsaugoma…</span>}
      </div>
      <div className="linkedin-graph-canvas">
        <ReactFlow
          nodes={boundNodes}
          edges={edges}
          onNodesChange={handleNodesChangeWrapped}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

export function CampaignGraphEditor({ campaignId }: { campaignId: string }) {
  return (
    <ReactFlowProvider>
      <EditorInner campaignId={campaignId} />
    </ReactFlowProvider>
  );
}
