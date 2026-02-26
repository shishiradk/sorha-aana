export const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nepal Real Estate AI</title>
    <style>
        :root {
            --bg: #ffffff;
            --text: #000000;
            --border: #000000;
            --accent: #008037; /* Nepal Green */
        }
        body {
            font-family: "Courier New", Courier, monospace; /* Monospace fits bw vibe */
            background-color: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 20px;
            line-height: 1.6;
            min-height: 100vh;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        header {
            text-align: center;
            margin-bottom: 40px;
            padding-top: 20px;
            border-bottom: 2px solid var(--border);
            padding-bottom: 20px;
        }
        h1 {
            font-size: 2.5rem;
            margin-bottom: 5px;
            text-transform: uppercase;
            letter-spacing: -1px;
        }
        .search-box {
            position: relative;
            margin-bottom: 40px;
        }
        input {
            width: 100%;
            padding: 20px;
            font-size: 1.2rem;
            background: var(--bg);
            border: 2px solid var(--border);
            color: var(--text);
            box-sizing: border-box;
            border-radius: 0; /* Sharp corners */
            font-family: inherit;
        }
        input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 2px rgba(0, 128, 55, 0.2);
            background: #fff;
            color: #000;
        }
        button {
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            background: var(--accent);
            color: #fff;
            border: none;
            padding: 10px 20px;
            cursor: pointer;
            text-transform: uppercase;
            font-weight: bold;
            font-family: inherit;
        }
        button:hover {
            opacity: 0.8;
        }
        #loading {
            display: none;
            text-align: center;
            font-weight: bold;
            padding: 20px;
            border: 1px dashed var(--border);
        }
        .ai-response {
            border: 2px solid var(--border);
            padding: 20px;
            margin-bottom: 40px;
            display: none;
        }
        .ai-label {
            font-size: 0.8rem;
            text-transform: uppercase;
            font-weight: bold;
            border-bottom: 1px solid var(--border);
            display: inline-block;
            margin-bottom: 15px;
            padding-bottom: 2px;
        }
        .property-grid {
            display: grid;
            gap: 0;
            border: 2px solid var(--border);
        }
        .property-card {
            border-bottom: 1px solid var(--border);
            padding: 20px;
            transition: background 0.2s;
        }
        .property-card:last-child {
            border-bottom: none;
        }
        .property-card:hover {
            background: #f0f0f0;
        }
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 10px;
        }
        .card-title {
            font-size: 1.4rem;
            font-weight: bold;
            margin: 0;
            text-transform: uppercase;
        }
        .score {
            font-size: 0.9rem;
            background: var(--accent);
            color: #fff;
            padding: 2px 6px;
        }
        .card-price {
            font-size: 1.2rem;
            font-weight: bold;
            margin-bottom: 10px;
            border-bottom: 1px dotted #000;
            display: inline-block;
        }
        .card-details {
            display: flex;
            gap: 20px;
            font-size: 0.9rem;
            margin-bottom: 10px;
            font-weight: bold;
        }
        .card-location {
            font-size: 0.9rem;
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Nepal Real Estate AI</h1>
            <p>MINIMALIST RAG SEARCH AGENT</p>
        </header>

        <form id="searchForm" class="search-box">
            <input type="text" id="query" placeholder="SEARCH PROPERTIES..." required autocomplete="off">
            <button type="submit">ENTER</button>
        </form>

        <div id="loading">PROCESSING QUERY...</div>

        <div id="resultArea" style="display: none;">
            <div class="ai-response">
                <div class="ai-label">AI Analysis</div>
                <div id="aiText"></div>
            </div>

            <div class="ai-label" style="margin-bottom: 20px;">Available Listings</div>
            <div id="listings" class="property-grid"></div>
        </div>
    </div>

    <script>
        const form = document.getElementById('searchForm');
        const loading = document.getElementById('loading');
        const resultArea = document.getElementById('resultArea');
        const aiText = document.getElementById('aiText');
        const listings = document.getElementById('listings');

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const query = document.getElementById('query').value;
            
            loading.style.display = 'block';
            resultArea.style.display = 'none';

            try {
                const res = await fetch('/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query })
                });

                const data = await res.json();
                
                // Show AI Answer
                aiText.innerHTML = data.answer.replace(/\\n/g, '<br>'); // Simple line break
                document.querySelector('.ai-response').style.display = 'block';

                // Show Listings
                const val = v => (v !== null && v !== undefined && v !== '' && v !== 'null') ? v : null;

                listings.innerHTML = data.properties.map(p => {
                    const details = [
                        val(p.bedrooms) ? p.bedrooms + ' BEDS' : null,
                        val(p.layout) && !val(p.bedrooms) ? p.layout : null,
                        val(p.listing_type) ? p.listing_type.toUpperCase() : null,
                        val(p.property_type) ? p.property_type.toUpperCase() : null,
                    ].filter(Boolean);

                    const meta = [
                        val(p.area),
                        val(p.facing),
                        val(p.road_access),
                        p.furnished === 'YES' ? 'Furnished' : null,
                        val(p.house_storey) ? p.house_storey + ' Storey' : null,
                    ].filter(Boolean);

                    const location = val(p.location) || val(p.district) || 'Nepal';

                    return \`
                    <div class="property-card">
                        <div class="card-header">
                            <h3 class="card-title">\${p.title}</h3>
                            <span class="score">\${Math.round(p.similarity * 100)}% MATCH</span>
                        </div>
                        <div class="card-price">\${val(p.price) || 'Price on request'}</div>
                        \${details.length ? \`<div class="card-details">\${details.map(d => \`<span>\${d}</span>\`).join('')}</div>\` : ''}
                        \${meta.length ? \`<div class="card-details" style="font-weight:normal;color:#555;">\${meta.map(m => \`<span>\${m}</span>\`).join('')}</div>\` : ''}
                        <div class="card-location">\${location}</div>
                    </div>\`;
                }).join('');

                resultArea.style.display = 'block';
            } catch (error) {
                alert('ERROR: ' + error.message);
            } finally {
                loading.style.display = 'none';
            }
        });
    </script>
</body>
</html>
`;
