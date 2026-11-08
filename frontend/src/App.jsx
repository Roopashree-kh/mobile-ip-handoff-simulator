// Single-screen network operations console. Resizable panels:
//   top bar
//   [ controls | topology map | agent state ]
//   [ packet inspector (full width)          ]
// plus the Analytics slide-out drawer and Learn mode toasts.
import React from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import TopBar from './components/TopBar.jsx';
import ControlPanel from './components/ControlPanel.jsx';
import TopologyMap from './components/TopologyMap.jsx';
import AgentPanel from './components/AgentPanel.jsx';
import PacketInspector from './components/PacketInspector.jsx';
import AnalyticsDrawer from './components/AnalyticsDrawer.jsx';
import LearnToasts from './components/LearnToasts.jsx';

export default function App() {
  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <div className="flex-1 min-h-0 p-1.5">
        <PanelGroup direction="vertical" autoSaveId="noc-v">
          <Panel defaultSize={62} minSize={30}>
            <PanelGroup direction="horizontal" autoSaveId="noc-h">
              <Panel defaultSize={19} minSize={14}><ControlPanel /></Panel>
              <PanelResizeHandle className="resize-h mx-0.5" />
              <Panel defaultSize={55} minSize={30}>
                <div className="relative h-full">
                  <TopologyMap />
                  <LearnToasts />
                </div>
              </Panel>
              <PanelResizeHandle className="resize-h mx-0.5" />
              <Panel defaultSize={26} minSize={16}><AgentPanel /></Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="resize-v my-0.5" />
          <Panel defaultSize={38} minSize={15}><PacketInspector /></Panel>
        </PanelGroup>
      </div>
      <AnalyticsDrawer />
    </div>
  );
}
