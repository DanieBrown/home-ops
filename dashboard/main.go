package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"runtime"

	tea "github.com/charmbracelet/bubbletea"

	"home-ops/dashboard/internal/data"
	"home-ops/dashboard/internal/theme"
	"home-ops/dashboard/internal/ui/screens"
)

type viewState int

const (
	viewPipeline viewState = iota
	viewReport
)

type appModel struct {
	pipeline      screens.PipelineModel
	viewer        screens.ViewerModel
	state         viewState
	homeOpsPath   string
}

func (m appModel) Init() tea.Cmd {
	return nil
}

func (m appModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.pipeline.Resize(msg.Width, msg.Height)
		if m.state == viewReport {
			m.viewer.Resize(msg.Width, msg.Height)
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd

	case screens.PipelineClosedMsg:
		return m, tea.Quit

	case screens.PipelineLoadReportMsg:
		summary := data.LoadReportSummary(msg.HomeOpsPath, msg.ReportPath)
		m.pipeline.EnrichReport(msg.ReportPath, summary)
		return m, nil

	case screens.PipelineUpdateStatusMsg:
		err := data.UpdateListingStatus(msg.HomeOpsPath, msg.Listing, msg.NewStatus)
		if err != nil {
			return m, nil
		}
		listings := data.ParseListings(m.homeOpsPath)
		metrics := data.ComputeMetrics(listings)
		old := m.pipeline
		m.pipeline = screens.NewPipelineModel(
			theme.NewTheme("catppuccin-mocha"),
			listings, metrics, m.homeOpsPath,
			old.Width(), old.Height(),
		)
		m.pipeline.CopyReportCache(&old)
		return m, nil

	case screens.PipelineOpenReportMsg:
		m.viewer = screens.NewViewerModel(
			theme.NewTheme("catppuccin-mocha"),
			msg.Path, msg.Title,
			m.pipeline.Width(), m.pipeline.Height(),
		)
		m.state = viewReport
		return m, nil

	case screens.ViewerClosedMsg:
		m.state = viewPipeline
		return m, nil

	case screens.PipelineOpenURLMsg:
		url := msg.URL
		return m, func() tea.Msg {
			var cmd *exec.Cmd
			switch runtime.GOOS {
			case "darwin":
				cmd = exec.Command("open", url)
			case "linux":
				cmd = exec.Command("xdg-open", url)
			case "windows":
				cmd = exec.Command("cmd", "/c", "start", "", url)
			default:
				cmd = exec.Command("xdg-open", url)
			}
			_ = cmd.Start()
			return nil
		}

	default:
		if m.state == viewReport {
			vm, cmd := m.viewer.Update(msg)
			m.viewer = vm
			return m, cmd
		}
		pm, cmd := m.pipeline.Update(msg)
		m.pipeline = pm
		return m, cmd
	}
}

func (m appModel) View() string {
	if m.state == viewReport {
		return m.viewer.View()
	}
	return m.pipeline.View()
}

func main() {
	pathFlag := flag.String("path", ".", "Path to home-ops directory")
	flag.Parse()

	homeOpsPath := *pathFlag

	// Load listings
	listings := data.ParseListings(homeOpsPath)
	if listings == nil {
		fmt.Fprintf(os.Stderr, "Error: could not find listings.md in %s or %s/data/\n", homeOpsPath, homeOpsPath)
		os.Exit(1)
	}

	// Compute metrics
	metrics := data.ComputeMetrics(listings)

	// Batch-load all report summaries
	t := theme.NewTheme("catppuccin-mocha")
	pm := screens.NewPipelineModel(t, listings, metrics, homeOpsPath, 120, 40)

	for _, listing := range listings {
		if listing.ReportPath == "" {
			continue
		}
		summary := data.LoadReportSummary(homeOpsPath, listing.ReportPath)
		if summary.URL != "" || summary.Recommendation != "" || summary.Confidence != "" || summary.Summary != "" || summary.Price != "" {
			pm.EnrichReport(listing.ReportPath, summary)
		}
	}

	m := appModel{
		pipeline:      pm,
		homeOpsPath:   homeOpsPath,
	}

	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
