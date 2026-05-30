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
            --accent: #008037;
            --muted: #666;
        }
        body {
            font-family: "Courier New", Courier, monospace;
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
            border-radius: 0;
            font-family: inherit;
        }
        input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 2px rgba(0, 128, 55, 0.2);
            background: #fff;
            color: #000;
        }
        .search-box button {
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
        .search-box button:hover { opacity: 0.8; }
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
            margin-bottom: 30px;
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
        .result-summary {
            font-size: 0.85rem;
            color: var(--muted);
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
        }
        .cache-badge {
            font-size: 0.72rem;
            font-weight: bold;
            padding: 2px 7px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .cache-hit  { background: #e6f4ec; color: var(--accent); border: 1px solid var(--accent); }
        .cache-miss { background: #f0f0f0; color: #555; border: 1px solid #aaa; }
        .resp-time  { font-size: 0.75rem; color: #aaa; }
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
        .property-card:last-child { border-bottom: none; }
        .property-card:hover { background: #f0f0f0; }
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            gap: 10px;
            margin-bottom: 10px;
        }
        .card-title {
            font-size: 1.2rem;
            font-weight: bold;
            margin: 0;
            text-transform: uppercase;
        }
        .card-badges { display: flex; gap: 4px; flex-shrink: 0; }
        .badge {
            font-size: 0.8rem;
            color: #fff;
            padding: 2px 6px;
            white-space: nowrap;
        }
        .badge-match { background: var(--accent); }
        .badge-dist { background: #333; }
        .card-price {
            font-size: 1.2rem;
            font-weight: bold;
            margin-bottom: 10px;
            border-bottom: 1px dotted #000;
            display: inline-block;
        }
        .card-details {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            font-size: 0.9rem;
            margin-bottom: 8px;
            font-weight: bold;
        }
        .card-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            font-size: 0.85rem;
            margin-bottom: 8px;
            color: var(--muted);
        }
        .card-remarks {
            font-size: 0.85rem;
            color: #444;
            margin-bottom: 8px;
            max-height: 3.6em;
            overflow: hidden;
        }
        .card-amenities {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 8px;
        }
        .tag {
            font-size: 0.75rem;
            background: #eee;
            border: 1px solid #ccc;
            padding: 1px 6px;
        }
        .card-location { font-size: 0.9rem; font-style: italic; }
        .card-contact {
            font-size: 0.85rem;
            margin-top: 6px;
            padding: 4px 8px;
            background: #f5f5f5;
            border-left: 3px solid var(--accent);
        }
        .no-results {
            text-align: center;
            padding: 40px 20px;
            color: var(--muted);
            border: 2px solid var(--border);
        }
        .auth-bar {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            padding: 15px;
            border: 2px solid var(--border);
            background: #fafafa;
            align-items: center;
            flex-wrap: wrap;
        }
        .auth-bar label {
            font-size: 0.85rem;
            font-weight: bold;
            text-transform: uppercase;
            white-space: nowrap;
        }
        .auth-bar input {
            flex: 1;
            padding: 10px;
            font-size: 0.95rem;
            min-width: 120px;
            border: 1px solid var(--border);
        }
        .auth-bar .auth-field {
            display: flex;
            align-items: center;
            gap: 6px;
            flex: 1;
            min-width: 180px;
        }
        .auth-status {
            font-size: 0.8rem;
            padding: 4px 8px;
            font-weight: bold;
            white-space: nowrap;
        }
        .auth-ok { color: var(--accent); }
        .auth-no { color: #c00; }
        .property-card { cursor: pointer; }
        .modal-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.55);
            z-index: 1000;
            overflow-y: auto;
            padding: 40px 20px;
        }
        .modal-overlay.open { display: block; }
        .modal {
            background: #fff;
            border: 2px solid #000;
            max-width: 680px;
            margin: 0 auto;
            padding: 30px;
            position: relative;
            font-family: "Courier New", Courier, monospace;
        }
        .modal-close {
            position: absolute;
            top: 12px;
            right: 16px;
            font-size: 1.4rem;
            cursor: pointer;
            background: none;
            border: none;
            font-family: inherit;
            font-weight: bold;
            line-height: 1;
        }
        .modal-close:hover { color: #c00; }
        .modal-title {
            font-size: 1.2rem;
            font-weight: bold;
            text-transform: uppercase;
            margin-bottom: 6px;
            padding-right: 30px;
        }
        .modal-price {
            font-size: 1.4rem;
            font-weight: bold;
            border-bottom: 2px solid #000;
            padding-bottom: 10px;
            margin-bottom: 16px;
        }
        .modal-section {
            margin-bottom: 14px;
        }
        .modal-section-label {
            font-size: 0.75rem;
            font-weight: bold;
            text-transform: uppercase;
            color: var(--muted);
            margin-bottom: 4px;
        }
        .modal-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px 24px;
            font-size: 0.9rem;
        }
        .modal-field { display: flex; flex-direction: column; }
        .modal-field-label { font-size: 0.72rem; text-transform: uppercase; color: var(--muted); }
        .modal-field-value { font-weight: bold; }
        .modal-remarks {
            font-size: 0.88rem;
            color: #333;
            line-height: 1.6;
            border-left: 3px solid var(--accent);
            padding-left: 10px;
        }
        .modal-amenities { display: flex; flex-wrap: wrap; gap: 4px; }
        .modal-contact {
            background: #f5f5f5;
            border-left: 3px solid var(--accent);
            padding: 8px 12px;
            font-size: 0.9rem;
        }
        .modal-id {
            font-size: 0.75rem;
            color: #999;
            margin-top: 16px;
            border-top: 1px solid #eee;
            padding-top: 8px;
        }
        .role-indicator {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 0.78rem;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 1px;
            padding: 5px 10px;
            border: 1px solid #ccc;
            color: var(--muted);
            margin-bottom: 12px;
        }
        .role-indicator.buyer { border-color: var(--accent); color: var(--accent); }
        .role-indicator.seller { border-color: #111; color: #111; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Real Estate AI</h1>
            <p>AI-POWERED PROPERTY SEARCH &mdash; KASKI, NEPAL</p>
        </header>

        <div class="auth-bar">
            <div class="auth-field">
                <label for="apiKey">API Key:</label>
                <input type="password" id="apiKey" placeholder="Enter API key" autocomplete="off">
            </div>
            <div class="auth-field">
                <label for="ownerId">Owner ID:</label>
                <input type="number" id="ownerId" placeholder="e.g. 3" min="1" autocomplete="off">
            </div>
            <span id="authStatus" class="auth-status auth-no">NOT AUTHORIZED</span>
        </div>

        <div id="roleIndicator" class="role-indicator" style="display:none"></div>

        <form id="searchForm" class="search-box">
            <input type="text" id="query" placeholder="Search properties..." required autocomplete="off">
            <button type="submit">SEARCH</button>
        </form>

        <div id="loading">SEARCHING...</div>

        <div id="resultArea" style="display: none;">
            <div class="ai-response">
                <div class="ai-label">AI Analysis</div>
                <div id="aiText"></div>
            </div>

            <div id="resultSummary" class="result-summary"></div>
            <div class="ai-label" style="margin-bottom: 20px;">Results</div>
            <div id="listings" class="property-grid"></div>
        </div>
    </div>

    <div id="modalOverlay" class="modal-overlay" onclick="closeModal(event)">
        <div class="modal" id="modalBox">
            <button class="modal-close" onclick="closeModalDirect()">&times;</button>
            <div id="modalContent"></div>
        </div>
    </div>

    <script>
        var allProperties = [];

        function openModal(idx) {
            var p = allProperties[idx];
            if (!p) return;
            var isPerson = ['Buyer','Tenant','Agent'].indexOf(p.listing_type) !== -1;
            var priceLabel = p.listing_type === 'Rent' ? 'Rent' : p.listing_type === 'Buyer' ? 'Budget' : p.listing_type === 'Tenant' ? 'Rent Budget' : 'Price';
            var priceText = val(p.price) || (isPerson ? 'Flexible' : 'Price on request');

            var html = '<div class="modal-title">' + (p.title || 'Untitled') + '</div>';
            html += '<div class="modal-price">' + priceLabel + ': ' + priceText + '</div>';

            // Key fields grid
            var fields = [];
            if (val(p.listing_type))      fields.push(['Type', p.listing_type]);
            if (val(p.property_type))     fields.push(['Property', p.property_type]);
            if (val(p.property_category)) fields.push(['Category', p.property_category]);
            if (val(p.bedrooms))          fields.push(['Bedrooms', p.bedrooms]);
            if (val(p.layout))            fields.push(['Layout', p.layout]);
            if (val(p.area))              fields.push(['Area', p.area]);
            if (val(p.house_area))        fields.push(['Built-up', p.house_area]);
            if (val(p.land_area))         fields.push(['Land Area', p.land_area]);
            if (val(p.house_storey))      fields.push(['Storeys', p.house_storey]);
            if (val(p.facing))            fields.push(['Facing', p.facing]);
            if (val(p.road_access))       fields.push(['Road', p.road_access]);
            if (val(p.parking) && p.parking !== 'NO') fields.push(['Parking', p.parking]);
            if (p.furnished === 'YES')    fields.push(['Furnished', 'Yes']);
            if (val(p.compound))          fields.push(['Compound', p.compound]);
            if (val(p.kitchen))           fields.push(['Kitchen', p.kitchen]);
            if (val(p.living_room))       fields.push(['Living Room', p.living_room]);
            if (val(p.district))          fields.push(['District', p.district]);
            if (val(p.municipality))      fields.push(['Municipality', p.municipality]);
            if (val(p.province))          fields.push(['Province', p.province]);
            if (p.distance_km != null)    fields.push(['Distance', p.distance_km.toFixed(1) + ' km away']);

            if (fields.length) {
                html += '<div class="modal-section">';
                html += '<div class="modal-row">';
                for (var i = 0; i < fields.length; i++) {
                    html += '<div class="modal-field"><span class="modal-field-label">' + fields[i][0] + '</span><span class="modal-field-value">' + fields[i][1] + '</span></div>';
                }
                html += '</div></div>';
            }

            // Location
            if (val(p.location)) {
                html += '<div class="modal-section"><div class="modal-section-label">Location</div><div>' + p.location + '</div></div>';
            }

            // Amenities
            if (Array.isArray(p.amenities) && p.amenities.length) {
                html += '<div class="modal-section"><div class="modal-section-label">Amenities</div><div class="modal-amenities">';
                for (var i = 0; i < p.amenities.length; i++) {
                    if (p.amenities[i] && p.amenities[i].trim()) html += '<span class="tag">' + p.amenities[i].trim() + '</span>';
                }
                html += '</div></div>';
            }

            // Remarks
            var remarks = val(p.remarks) || val(p.rental_purpose) || null;
            if (remarks) {
                html += '<div class="modal-section"><div class="modal-section-label">Remarks</div><div class="modal-remarks">' + remarks + '</div></div>';
            }

            // Contact (person cards)
            if (val(p.name) || val(p.phone)) {
                html += '<div class="modal-section"><div class="modal-section-label">Contact</div><div class="modal-contact">';
                if (val(p.name))  html += '<div><strong>' + p.name + '</strong></div>';
                if (val(p.phone)) html += '<div>' + p.phone + '</div>';
                html += '</div></div>';
            }

            html += '<div class="modal-id">ID: ' + p.id + ' &nbsp;&bull;&nbsp; Table: ' + p.source_table + ' &nbsp;&bull;&nbsp; Match: ' + Math.round((p.similarity || 0) * 100) + '%</div>';

            document.getElementById('modalContent').innerHTML = html;
            document.getElementById('modalOverlay').classList.add('open');
            document.body.style.overflow = 'hidden';
        }

        function closeModal(e) {
            if (e.target === document.getElementById('modalOverlay')) closeModalDirect();
        }
        function closeModalDirect() {
            document.getElementById('modalOverlay').classList.remove('open');
            document.body.style.overflow = '';
        }
        document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModalDirect(); });

        const form = document.getElementById('searchForm');
        const loading = document.getElementById('loading');
        const resultArea = document.getElementById('resultArea');
        const aiText = document.getElementById('aiText');
        const listings = document.getElementById('listings');
        const resultSummary = document.getElementById('resultSummary');

        function showRoleIndicator(role) {
            var el = document.getElementById('roleIndicator');
            el.className = 'role-indicator ' + role;
            el.textContent = role === 'seller' ? 'MODE: FINDING LEADS' : 'MODE: FINDING PROPERTIES';
            el.style.display = 'inline-flex';
        }

        // Check if value is meaningful (not null/undefined/empty/0)
        function val(v) {
            if (v === null || v === undefined || v === '' || v === 'null' || v === 'N/A') return null;
            return v;
        }

        function renderCard(p) {
            var isPerson = ['Buyer','Tenant','Agent'].indexOf(p.listing_type) !== -1;

            // Match + distance badges
            var matchPct = p.similarity ? Math.round(p.similarity * 100) : 0;
            var distHtml = '';
            if (p.distance_km !== null && p.distance_km !== undefined) {
                var distText = p.distance_km === 0 ? 'Exact location' : p.distance_km.toFixed(1) + ' km';
                distHtml = '<span class="badge badge-dist">' + distText + '</span>';
            }

            // Price
            var pricePrefix = '';
            if (p.listing_type === 'Buyer') pricePrefix = 'Budget: ';
            else if (p.listing_type === 'Tenant') pricePrefix = 'Rent Budget: ';
            var priceText = val(p.price) || (isPerson ? 'Flexible' : 'Price on request');

            // Details row
            var details = [];
            if (isPerson) {
                if (val(p.listing_type)) details.push(p.listing_type.toUpperCase());
                if (val(p.property_type)) details.push(p.property_type.toUpperCase());
                if (val(p.bedrooms)) details.push(p.bedrooms + ' BEDS NEEDED');
            } else {
                if (val(p.property_type)) details.push(p.property_type.toUpperCase());
                if (val(p.property_category)) details.push(p.property_category);
                if (val(p.listing_type)) details.push(p.listing_type.toUpperCase());
                if (val(p.bedrooms)) details.push(p.bedrooms + ' BED');
                else if (val(p.layout)) details.push(p.layout);
            }

            // Meta row
            var meta = [];
            if (!isPerson) {
                if (val(p.area)) meta.push(p.area);
                if (val(p.facing)) meta.push('Facing ' + p.facing);
                if (val(p.road_access)) meta.push(p.road_access);
                if (val(p.parking) && p.parking !== 'NO') meta.push('Parking: ' + p.parking);
                if (p.furnished === 'YES') meta.push('Furnished');
                if (val(p.house_storey)) meta.push(p.house_storey + ' Storey');
            }

            // Amenities
            var amenities = [];
            if (Array.isArray(p.amenities)) {
                for (var i = 0; i < p.amenities.length; i++) {
                    if (p.amenities[i] && p.amenities[i].trim()) amenities.push(p.amenities[i].trim());
                }
            }

            // Remarks
            var remarks = isPerson ? null : (val(p.remarks) || val(p.rental_purpose) || null);

            // Location
            var location = val(p.location) || val(p.district) || 'Nepal';

            // Contact — show for all listing types
            var contactHtml = '';
            if (val(p.phone)) {
                var contactLabel = isPerson ? 'Contact' : 'Seller';
                contactHtml = '<div class="card-contact">' + contactLabel + ': ' + (val(p.name) ? p.name + ' &mdash; ' : '') + p.phone + '</div>';
            }

            var html = '<div class="property-card">';
            html += '<div class="card-header">';
            html += '<h3 class="card-title">' + (p.title || 'Untitled') + '</h3>';
            html += '<div class="card-badges">' + distHtml + '<span class="badge badge-match">' + matchPct + '%</span></div>';
            html += '</div>';
            html += '<div class="card-price">' + pricePrefix + priceText + '</div>';

            if (details.length) {
                html += '<div class="card-details">';
                for (var i = 0; i < details.length; i++) html += '<span>' + details[i] + '</span>';
                html += '</div>';
            }

            if (meta.length) {
                html += '<div class="card-meta">';
                for (var i = 0; i < meta.length; i++) html += '<span>' + meta[i] + '</span>';
                html += '</div>';
            }

            if (amenities.length) {
                html += '<div class="card-amenities">';
                for (var i = 0; i < amenities.length; i++) html += '<span class="tag">' + amenities[i] + '</span>';
                html += '</div>';
            }

            if (remarks) {
                html += '<div class="card-remarks">' + remarks + '</div>';
            }

            html += '<div class="card-location">' + location + '</div>';
            html += contactHtml;
            html += '</div>';
            return html;
        }

        // Auth status indicator
        var apiKeyInput = document.getElementById('apiKey');
        var ownerIdInput = document.getElementById('ownerId');
        var authStatus = document.getElementById('authStatus');

        function updateAuthStatus() {
            var hasKey = apiKeyInput.value.trim().length > 0;
            var hasOwner = ownerIdInput.value.trim().length > 0 && parseInt(ownerIdInput.value) > 0;
            if (hasKey && hasOwner) {
                authStatus.textContent = 'AUTHORIZED (Owner ' + ownerIdInput.value + ')';
                authStatus.className = 'auth-status auth-ok';
            } else if (!hasKey && !hasOwner) {
                authStatus.textContent = 'NOT AUTHORIZED';
                authStatus.className = 'auth-status auth-no';
            } else if (!hasKey) {
                authStatus.textContent = 'MISSING API KEY';
                authStatus.className = 'auth-status auth-no';
            } else {
                authStatus.textContent = 'MISSING OWNER ID';
                authStatus.className = 'auth-status auth-no';
            }
        }
        apiKeyInput.addEventListener('input', updateAuthStatus);
        ownerIdInput.addEventListener('input', updateAuthStatus);

        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            var query = document.getElementById('query').value;
            var apiKey = apiKeyInput.value.trim();
            var ownerId = parseInt(ownerIdInput.value) || null;

            if (!ownerId || !apiKey) {
                alert('Please enter both API Key and Owner ID before searching.');
                return;
            }

            loading.style.display = 'block';
            resultArea.style.display = 'none';

            try {
                var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey };
                var t0 = Date.now();
                var res = await fetch('/search', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ query: query, owner_id: ownerId })
                });
                var elapsed = Date.now() - t0;

                var data = await res.json();

                if (!res.ok || data.error) {
                    listings.innerHTML = '';
                    resultArea.style.display = 'block';
                    document.querySelector('.ai-response').style.display = 'block';
                    aiText.innerHTML = '<strong>Error:</strong> ' + (data.error || 'Unknown server error.');
                    resultSummary.textContent = '';
                    return;
                }

                // AI Answer
                var answerText = data.answer || 'No answer generated.';
                aiText.innerHTML = answerText.replace(/\\n/g, '<br>');
                document.querySelector('.ai-response').style.display = 'block';

                // Show auto-detected role indicator
                showRoleIndicator(data.role || 'buyer');

                // Summary + cache badge + response time
                var intentLabel = data.listing_intent ? ' (' + data.listing_intent + ')' : '';
                var cacheClass = data.cached ? 'cache-hit' : 'cache-miss';
                var cacheText  = data.cached ? 'CACHED' : 'LIVE';
                resultSummary.innerHTML =
                    '<span>' + (data.total_results || 0) + ' results found' + intentLabel + '</span>' +
                    '<span class="cache-badge ' + cacheClass + '">' + cacheText + '</span>' +
                    '<span class="resp-time">' + elapsed + 'ms</span>';

                // Render listings
                if (!data.properties || data.properties.length === 0) {
                    var noResultMsg = data.role === 'seller'
                        ? 'No matching buyers or tenants found. Try a different query.'
                        : 'No matching properties found. Try a different query.';
                    listings.innerHTML = '<div class="no-results">' + noResultMsg + '</div>';
                } else {
                    allProperties = data.properties;
                    var cards = '';
                    for (var i = 0; i < data.properties.length; i++) {
                        cards += '<div onclick="openModal(' + i + ')">' + renderCard(data.properties[i]) + '</div>';
                    }
                    listings.innerHTML = cards;
                }

                resultArea.style.display = 'block';
            } catch (error) {
                alert('Search failed: ' + error.message);
            } finally {
                loading.style.display = 'none';
            }
        });
    </script>
</body>
</html>
`;
