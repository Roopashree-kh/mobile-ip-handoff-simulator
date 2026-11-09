// Single-screen network operations console. Resizable panels:
//   top bar
//   [ controls | topology map (hero) | agent state ]
//   [ packet inspector, collapsible to its header bar ]
// plus the Analytics slide-out drawer. Learn mode entries live in the bottom panel.
import React, { useEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import TopBar from './components/TopBar.jsx';
import ControlPanel from './components/ControlPanel.jsx';
import TopologyMap from './components/TopologyMap.jsx';
import AgentPanel from './components/AgentPanel.jsx';
import PacketInspector from './components/PacketInspector.jsx';
import AnalyticsDrawer from './components/AnalyticsDrawer.jsx';

const BAR_PX = 42; // inspector header plus its border, the height of the collapsed bar
// narrower screens give the side panels a larger share so their tables still fit
const WIDE = typeof window === 'undefined' || window.innerWidth >= 1600;
const SIZES = WIDE ? [18, 60, 22] : [20, 52, 28];

export default function App() {
  const area = useRef(null);
  const inspector = useRef(null);
  const [barPct, setBarPct] = useState(5);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const el = area.current;
    const ro = new ResizeObserver(() => setBarPct(Math.min(20, (BAR_PX / Math.max(200, el.clientHeight)) * 100)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toggle = () => {
    const p = inspector.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  };

  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <div ref={area} className="flex-1 min-h-0 p-2">
        <PanelGroup direction="vertical" autoSaveId="lt-v">
          <Panel defaultSize={70} minSize={35}>
            <PanelGroup direction="horizontal" autoSaveId={WIDE ? 'lt-h' : 'lt-h-narrow'}>
              <Panel defaultSize={SIZES[0]} minSize={14} maxSize={28}><ControlPanel /></Panel>
              <PanelResizeHandle className="resize-h" />
              <Panel defaultSize={SIZES[1]} minSize={35}>
                <TopologyMap />
              </Panel>
              <PanelResizeHandle className="resize-h" />
              <Panel defaultSize={SIZES[2]} minSize={16} maxSize={34}><AgentPanel /></Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="resize-v" />
          <Panel ref={inspector} defaultSize={30} minSize={14} collapsible collapsedSize={barPct}
            onCollapse={() => setCollapsed(true)} onExpand={() => setCollapsed(false)}>
            <PacketInspector collapsed={collapsed} onToggle={toggle} />
          </Panel>
        </PanelGroup>
      </div>
      <AnalyticsDrawer />
    </div>
  );
}
