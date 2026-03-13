package main

import (
	"fmt"
	"io"
	"log"

	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	http "github.com/bogdanfinn/fhttp"
)

func main() {
	options := []tls_client.HttpClientOption{
		tls_client.WithTimeoutSeconds(10),
		tls_client.WithClientProfile(profiles.Chrome_131),
		tls_client.WithNotFollowRedirects(),
	}

	client, err := tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
	if err != nil {
		log.Fatal(err)
	}

	urls := []string{
		"https://www.vinted.de/api/v2/catalog/items?search_text=nike&order=newest_first&_=1711234567890",
		"https://www.vinted.de/api/v2/catalog/items?search_text=nike&order=newest_first&_=1711234567891",
		"https://www.vinted.de/api/v2/catalog/items?search_text=nike&order=newest_first&time=1711234567890",
		"https://www.vinted.de/api/v2/catalog/items?search_text=nike&order=newest_first&time=1711234567891",
	}

	for _, u := range urls {
		req, _ := http.NewRequest("GET", u, nil)
		req.Header = http.Header{
			"User-Agent":         {"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"},
			"Accept":             {"application/json, text/plain, */*"},
		}
		resp, err := client.Do(req)
		if err != nil {
			fmt.Printf("Err: %v\n", err)
			continue
		}

		fmt.Printf("URL: %s\n", u)
		fmt.Printf("Status: %d\n", resp.StatusCode)
		fmt.Printf("CF-Cache-Status: %s\n", resp.Header.Get("Cf-Cache-Status"))
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		fmt.Println("---")
	}
}
