package data

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"home-ops/dashboard/internal/model"
)

var (
	reReportLink      = regexp.MustCompile(`\[(\d+)\]\(([^)]+)\)`)
	reScoreValue      = regexp.MustCompile(`(\d+\.?\d*)/5`)
	reDigits          = regexp.MustCompile(`\d+`)
	reReportURL       = regexp.MustCompile(`(?mi)^\*\*URL:\*\*\s*(https?://\S+)`)
	reRecommendation  = regexp.MustCompile(`(?mi)^\*\*Recommendation:\*\*\s*(.+)$`)
	reConfidence      = regexp.MustCompile(`(?mi)^\*\*Confidence:\*\*\s*(.+)$`)
	reReportPrice     = regexp.MustCompile(`(?mi)^\*\*Price:\*\*\s*(.+)$`)
)

// ReportSummary holds the subset of report data shown in the dashboard preview.
type ReportSummary struct {
	URL            string
	Recommendation string
	Confidence     string
	Summary        string
	Price          string
}

// ParseListings reads data/listings.md and returns tracker rows.
func ParseListings(homeOpsPath string) []model.Listing {
	filePath := filepath.Join(homeOpsPath, "data", "listings.md")
	content, err := os.ReadFile(filePath)
	if err != nil {
		filePath = filepath.Join(homeOpsPath, "listings.md")
		content, err = os.ReadFile(filePath)
		if err != nil {
			return nil
		}
	}

	lines := strings.Split(string(content), "\n")
	listings := make([]model.Listing, 0)

	for _, line := range lines {
		fields, ok := parseTrackerLine(line)
		if !ok || len(fields) < 11 {
			continue
		}

		listing := model.Listing{
			Number:    len(listings) + 1,
			Date:      fields[1],
			Address:   fields[2],
			City:      fields[3],
			Price:     fields[4],
			PriceValue: parseDigits(fields[4]),
			BedsBaths: fields[5],
			SqFt:      fields[6],
			SqFtValue: parseDigits(fields[6]),
			ScoreRaw:  fields[7],
			Status:    fields[8],
			Notes:     fields[10],
		}

		if number, err := strconv.Atoi(strings.TrimSpace(fields[0])); err == nil {
			listing.Number = number
		}

		if score := reScoreValue.FindStringSubmatch(fields[7]); score != nil {
			listing.Score, _ = strconv.ParseFloat(score[1], 64)
		}

		if report := reReportLink.FindStringSubmatch(fields[9]); report != nil {
			listing.ReportNumber = report[1]
			listing.ReportPath = report[2]
		}

		if listing.ReportPath != "" {
			summary := LoadReportSummary(homeOpsPath, listing.ReportPath)
			listing.ListingURL = summary.URL
		}

		listings = append(listings, listing)
	}

	return listings
}

// ComputeMetrics calculates aggregate metrics from listings.
func ComputeMetrics(listings []model.Listing) model.PipelineMetrics {
	m := model.PipelineMetrics{
		Total:    len(listings),
		ByStatus: make(map[string]int),
	}

	var totalScore float64
	var scored int
	var totalPrice int
	var priced int

	for _, listing := range listings {
		status := NormalizeStatus(listing.Status)
		m.ByStatus[status]++

		if listing.Score > 0 {
			totalScore += listing.Score
			scored++
			if listing.Score > m.TopScore {
				m.TopScore = listing.Score
			}
		}
		if listing.PriceValue > 0 {
			totalPrice += listing.PriceValue
			priced++
		}
		if status != "passed" && status != "sold" && status != "skip" && status != "closed" {
			m.Actionable++
		}
	}

	if scored > 0 {
		m.AvgScore = totalScore / float64(scored)
	}
	if priced > 0 {
		m.AvgPrice = totalPrice / priced
	}

	return m
}

// NormalizeStatus normalizes raw status text to a canonical form.
func NormalizeStatus(raw string) string {
	s := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(raw, "**", "")))
	replacer := strings.NewReplacer("-", " ", "_", " ", "/", " ")
	s = replacer.Replace(s)
	s = strings.Join(strings.Fields(s), " ")

	switch {
	case s == "skip" || strings.Contains(s, "skip"):
		return "skip"
	case strings.Contains(s, "under contract"):
		return "under-contract"
	case strings.Contains(s, "offer submitted"):
		return "offer-submitted"
	case strings.Contains(s, "tour scheduled"):
		return "tour-scheduled"
	case strings.Contains(s, "toured"):
		return "toured"
	case strings.Contains(s, "interested"):
		return "interested"
	case strings.Contains(s, "evaluated"):
		return "evaluated"
	case strings.Contains(s, "passed") || s == "pass":
		return "passed"
	case strings.Contains(s, "sold"):
		return "sold"
	case strings.Contains(s, "closed"):
		return "closed"
	case strings.Contains(s, "new"):
		return "new"
	default:
		return s
	}
}

// LoadReportSummary extracts key fields from a report file.
func LoadReportSummary(homeOpsPath, reportPath string) ReportSummary {
	fullPath := filepath.Join(homeOpsPath, reportPath)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return ReportSummary{}
	}
	text := string(content)

	summary := ReportSummary{
		URL:            extractField(text, reReportURL),
		Recommendation: extractField(text, reRecommendation),
		Confidence:     extractField(text, reConfidence),
		Price:          extractField(text, reReportPrice),
		Summary:        extractQuickTake(text),
	}

	if len(summary.Summary) > 180 {
		summary.Summary = summary.Summary[:177] + "..."
	}

	return summary
}

// UpdateListingStatus updates the status of a listing in data/listings.md.
func UpdateListingStatus(homeOpsPath string, listing model.Listing, newStatus string) error {
	filePath := filepath.Join(homeOpsPath, "data", "listings.md")
	content, err := os.ReadFile(filePath)
	if err != nil {
		filePath = filepath.Join(homeOpsPath, "listings.md")
		content, err = os.ReadFile(filePath)
		if err != nil {
			return err
		}
	}

	lines := strings.Split(string(content), "\n")
	found := false

	for i, line := range lines {
		fields, ok := parseTrackerLine(line)
		if !ok || len(fields) < 11 {
			continue
		}

		matched := false
		if listing.ReportNumber != "" {
			if report := reReportLink.FindStringSubmatch(fields[9]); report != nil && report[1] == listing.ReportNumber {
				matched = true
			}
		}
		if !matched && strings.EqualFold(strings.TrimSpace(fields[2]), strings.TrimSpace(listing.Address)) && strings.EqualFold(strings.TrimSpace(fields[3]), strings.TrimSpace(listing.City)) {
			matched = true
		}
		if matched {
			fields[8] = newStatus
			lines[i] = formatTrackerLine(fields)
			found = true
			break
		}
	}

	if !found {
		return fmt.Errorf("listing not found: %s, %s", listing.Address, listing.City)
	}

	return os.WriteFile(filePath, []byte(strings.Join(lines, "\n")), 0644)
}

// StatusPriority returns the sort priority for a status (lower = higher priority).
func StatusPriority(status string) int {
	switch NormalizeStatus(status) {
	case "under-contract":
		return 0
	case "offer-submitted":
		return 1
	case "tour-scheduled":
		return 2
	case "toured":
		return 3
	case "interested":
		return 4
	case "new":
		return 5
	case "evaluated":
		return 6
	case "passed":
		return 7
	case "sold":
		return 8
	case "skip":
		return 9
	case "closed":
		return 10
	default:
		return 99
	}
}

func parseTrackerLine(line string) ([]string, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || !strings.HasPrefix(trimmed, "|") || strings.HasPrefix(trimmed, "|---") || strings.HasPrefix(trimmed, "| #") {
		return nil, false
	}

	var fields []string
	if strings.Contains(trimmed, "\t") {
		trimmed = strings.TrimSpace(strings.TrimPrefix(trimmed, "|"))
		for _, part := range strings.Split(trimmed, "\t") {
			fields = append(fields, strings.TrimSpace(strings.Trim(part, "|")))
		}
	} else {
		for _, part := range strings.Split(strings.Trim(trimmed, "|"), "|") {
			fields = append(fields, strings.TrimSpace(part))
		}
	}

	if len(fields) == 0 || fields[0] == "#" {
		return nil, false
	}

	return fields, true
}

func formatTrackerLine(fields []string) string {
	return "| " + strings.Join(fields, " | ") + " |"
}

func parseDigits(value string) int {
	digits := strings.Join(reDigits.FindAllString(value, -1), "")
	if digits == "" {
		return 0
	}
	parsed, err := strconv.Atoi(digits)
	if err != nil {
		return 0
	}
	return parsed
}

func extractField(text string, pattern *regexp.Regexp) string {
	match := pattern.FindStringSubmatch(text)
	if match == nil {
		return ""
	}
	return strings.TrimSpace(strings.TrimRight(match[1], "|"))
}

func extractQuickTake(text string) string {
	lines := strings.Split(text, "\n")
	collecting := false
	parts := make([]string, 0, 3)

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !collecting {
			if strings.EqualFold(trimmed, "## Quick Take") {
				collecting = true
			}
			continue
		}

		if strings.HasPrefix(trimmed, "## ") {
			break
		}
		if trimmed == "" {
			if len(parts) > 0 {
				break
			}
			continue
		}
		if strings.HasPrefix(trimmed, "|") || trimmed == "---" || strings.HasPrefix(trimmed, "**") {
			continue
		}
		if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
			trimmed = strings.TrimSpace(trimmed[2:])
		}

		parts = append(parts, trimmed)
		if len(strings.Join(parts, " ")) > 220 {
			break
		}
	}

	return strings.Join(parts, " ")
}
