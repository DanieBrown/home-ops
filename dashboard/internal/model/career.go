package model

// Listing represents a single property row from the tracker.
type Listing struct {
	Number       int
	Date         string
	Address      string
	City         string
	Price        string
	PriceValue   int
	BedsBaths    string
	SqFt         string
	SqFtValue    int
	Status       string
	Score        float64
	ScoreRaw     string
	ReportPath   string
	ReportNumber string
	Notes        string
	ListingURL   string
}

// PipelineMetrics holds aggregate stats for the pipeline dashboard.
type PipelineMetrics struct {
	Total      int
	ByStatus   map[string]int
	AvgScore   float64
	TopScore   float64
	AvgPrice   int
	Actionable int
}
