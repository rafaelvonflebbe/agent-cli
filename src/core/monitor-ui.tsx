/**
 * Ink TUI components for the monitor dashboard
 */

import { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp, type Key } from 'ink';
import type { ProjectStatus, UserStory } from './types.js';
import { formatCost, POLL_INTERVAL_MS, pollAllProjects, loadStoriesForProject, readAgentLog } from './monitor-data.js';

type ViewMode = 'table' | 'detail';
type DetailSubView = 'stories' | 'logs';

const COL = {
  project: 20,
  branch: 18,
  iter: 8,
  stories: 10,
  status: 10,
  cost: 8,
  lastActivity: 20,
};

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  running: { label: 'RUNNING', color: 'green' },
  idle: { label: 'IDLE', color: 'yellow' },
  done: { label: 'DONE', color: 'cyan' },
  stopped: { label: 'STOPPED', color: 'red' },
};

function padCol(str: string, width: number): string {
  if (str.length > width) return str.slice(0, width - 1) + '\u2026';
  return str.padEnd(width);
}

/**
 * Single project row in the table
 */
function ProjectRow({ project, selected }: { project: ProjectStatus; selected: boolean }) {
  const sc = STATUS_CONFIG[project.status] ?? STATUS_CONFIG.stopped;
  const prefix = selected ? '\u276f ' : '  ';
  const row = [
    padCol(project.project, COL.project),
    padCol(project.branch, COL.branch),
    padCol(project.iteration, COL.iter),
    padCol(project.stories, COL.stories),
    padCol(sc.label, COL.status),
    padCol(formatCost(project.cost), COL.cost),
    padCol(project.lastActivity, COL.lastActivity),
  ].join('  ');

  if (selected) {
    return <Text backgroundColor="blue" color="white" bold>{prefix}{row}</Text>;
  }

  return <Text>{prefix}{row}</Text>;
}

/**
 * Project table with header and selectable rows
 */
function ProjectTable({ projects, selectedIndex }: { projects: ProjectStatus[]; selectedIndex: number }) {
  const headerCols = [
    padCol('PROJECT', COL.project),
    padCol('BRANCH', COL.branch),
    padCol('ITER', COL.iter),
    padCol('STORIES', COL.stories),
    padCol('STATUS', COL.status),
    padCol('COST', COL.cost),
    padCol('LAST ACTIVITY', COL.lastActivity),
  ].join('  ');

  const separator = '\u2500'.repeat(headerCols.length);

  return (
    <Box flexDirection="column">
      <Text bold color="gray">  {headerCols}</Text>
      <Text color="gray">  {separator}</Text>
      {projects.map((p, i) => (
        <ProjectRow key={p.directory} project={p} selected={i === selectedIndex} />
      ))}
      <Text color="gray">  {separator}</Text>
    </Box>
  );
}

/**
 * Detail view showing individual stories for a selected project
 */
function DetailView({ project, stories, subView, logs }: {
  project: ProjectStatus;
  stories: UserStory[];
  subView: DetailSubView;
  logs: string[];
}) {
  const sc = STATUS_CONFIG[project.status] ?? STATUS_CONFIG.stopped;
  const colId = 10;
  const colPri = 5;
  const colTitle = 40;
  const detailSep = '\u2500'.repeat(colId + colPri + colTitle + 8);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">{project.project}</Text>
        <Text> · </Text>
        <Text color="gray">{project.branch}</Text>
        <Text> · </Text>
        <Text color={sc.color}>{sc.label}</Text>
        <Text> · </Text>
        <Text color={subView === 'stories' ? 'cyan' : 'gray'}>stories</Text>
        <Text color="gray">/</Text>
        <Text color={subView === 'logs' ? 'cyan' : 'gray'}>logs</Text>
      </Box>
      <Text>{' '}</Text>

      {subView === 'logs' ? (
        <Box flexDirection="column">
          <Text bold color="gray">  Live Agent Output</Text>
          <Text color="gray">  {'\u2500'.repeat(80)}</Text>
          {logs.length === 0 ? (
            <Text color="gray">  No agent output yet. Start an agent to see live logs.</Text>
          ) : (
            logs.map((line, i) => (
              <Text key={i} wrap="truncate">{line}</Text>
            ))
          )}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold color="gray">  {'ID'.padEnd(colId)} {'PRI'.padEnd(colPri)} {'TITLE'.padEnd(colTitle)}</Text>
          <Text color="gray">  {detailSep}</Text>
          {stories.map(story => {
            const title = story.title.length > colTitle
              ? story.title.slice(0, colTitle - 2) + '\u2026'
              : story.title.padEnd(colTitle);
            return (
              <Box key={story.id}>
                <Text>  </Text>
                <Text color={story.passes ? 'green' : 'yellow'}>{story.passes ? '\u2714' : '\u25CF'}</Text>
                <Text> </Text>
                <Text>{story.id.padEnd(colId - 2)}</Text>
                <Text> {String(story.priority).padEnd(colPri - 1)}</Text>
                <Text> {title}</Text>
              </Box>
            );
          })}
          <Text color="gray">  {detailSep}</Text>
        </Box>
      )}

      <Box>
        <Text color="gray">  Press </Text>
        <Text bold>s</Text>
        <Text color="gray"> for stories · </Text>
        <Text bold>l</Text>
        <Text color="gray"> for logs · </Text>
        <Text bold>t</Text>
        <Text color="gray"> to return to table</Text>
      </Box>
    </Box>
  );
}

/**
 * Main Ink app component — manages state, polling, and keyboard input
 */
export function MonitorApp() {
  const [projects, setProjects] = useState<ProjectStatus[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<ViewMode>('table');
  const [detailStories, setDetailStories] = useState<UserStory[]>([]);
  const [detailProject, setDetailProject] = useState<ProjectStatus | null>(null);
  const [detailSubView, setDetailSubView] = useState<DetailSubView>('stories');
  const [detailLogs, setDetailLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const { exit } = useApp();

  // Poll for data every 2 seconds
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const valid = await pollAllProjects();
        if (!cancelled) {
          setProjects(valid);
          setLoading(false);
        }
        // Refresh logs when in detail view
        if (!cancelled && view === 'detail' && detailProject) {
          const logs = readAgentLog(detailProject.directory);
          setDetailLogs(logs);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Clamp selectedIndex when projects change
  useEffect(() => {
    if (projects.length > 0 && selectedIndex >= projects.length) {
      setSelectedIndex(Math.max(0, projects.length - 1));
    }
  }, [projects.length, selectedIndex]);

  // Keyboard input
  useInput((input: string, key: Key) => {
    if (input === 'q') {
      exit();
      return;
    }

    if (view === 'detail') {
      if (input === 't' || key.escape) {
        setView('table');
        setDetailStories([]);
        setDetailProject(null);
        setDetailSubView('stories');
        setDetailLogs([]);
        return;
      }
      if (input === 's') {
        setDetailSubView('stories');
        return;
      }
      if (input === 'l') {
        setDetailSubView('logs');
        if (detailProject) {
          setDetailLogs(readAgentLog(detailProject.directory));
        }
        return;
      }
    }

    if (view === 'table') {
      if (key.upArrow) {
        setSelectedIndex(i => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSelectedIndex(i => Math.min(Math.max(projects.length - 1, 0), i + 1));
      } else if (key.return && projects.length > 0) {
        const project = projects[selectedIndex];
        if (project) {
          loadStoriesForProject(project.directory).then(stories => {
            setDetailStories(stories);
            setDetailProject(project);
            setDetailSubView('stories');
            setDetailLogs(readAgentLog(project.directory));
            setView('detail');
          });
        }
      } else if (key.escape) {
        exit();
      }
    }
  });

  const now = new Date().toLocaleTimeString();

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold color="cyan">Agent CLI Monitor</Text>
        <Text color="gray">{' '}— refreshing every {POLL_INTERVAL_MS / 1000}s</Text>
      </Box>
      <Text>{' '}</Text>

      {loading ? (
        <Text color="gray">Loading...</Text>
      ) : projects.length === 0 ? (
        <Text color="gray">No directories configured. Use `agent-cli watch --add &lt;path&gt;` to add one.</Text>
      ) : view === 'detail' && detailProject ? (
        <DetailView project={detailProject} stories={detailStories} subView={detailSubView} logs={detailLogs} />
      ) : (
        <ProjectTable projects={projects} selectedIndex={selectedIndex} />
      )}

      <Text>{' '}</Text>
      <Text color="gray">{projects.length} director{projects.length === 1 ? 'y' : 'ies'} · {now} · q to quit</Text>
    </Box>
  );
}
