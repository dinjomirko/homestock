// The dinner plan on the Recipes tab: the next seven dinners, picked to use what's in stock
// first (soonest use-by first), for two adults and two toddlers. Pure, so it's tested on its own.
//
// Stock comes in as [{ id, name, qty, unit, days }], where days is how long until the use-by date
// (null when there isn't one, below zero once it's past).

// The foods recipes call for. `buy`: its name on the shopping list. `names`: what it goes by in
// stock, singular (plurals match too). `not`: things with the same name that aren't it. `pack`:
// counted one by one but often kept by the carton, and how many a carton holds. `canned`: how
// much of a recipe's amount one can is (two cans of chunk chicken make a pound).
export const FOODS = {
  eggs: { buy: 'Eggs', names: 'egg', pack: 12 },
  milk: { buy: 'Milk', names: 'milk', not: /coconut|condensed|evaporated|powdered/ },
  cheese: { buy: 'Shredded cheddar', names: 'cheddar|shredded cheese|sliced cheese|grated cheese|mexican blend|cheese blend|colby|monterey jack|pepper jack|american cheese|mozzarella|pizza cheese' },
  parmesan: { buy: 'Parmesan', names: 'parmesan|parmigiano' },
  yogurt: { buy: 'Plain Greek yogurt', names: 'greek yogurt|plain yogurt|sour cream' },
  butter: { buy: 'Butter', names: 'butter', not: /peanut|almond|cashew|sunflower|apple|cookie|nut butter/ },
  chicken: { buy: 'Chicken breasts', names: 'chicken', not: /cream of/, canned: 0.5 },
  groundMeat: { buy: 'Ground turkey', names: 'ground turkey|ground beef|ground chicken|ground pork|lean ground|ground meat' },
  salmon: { buy: 'Salmon fillets', names: 'salmon', not: /smoked|lox/ },
  whiteFish: { buy: 'Cod fillets', names: 'cod|tilapia|white fish|haddock|pollock|halibut|swai' },
  shrimp: { buy: 'Frozen shrimp', names: 'shrimp|prawn' },
  tuna: { buy: 'Canned light tuna', names: 'tuna' },
  beans: { buy: 'Black beans', names: 'black bean|pinto bean|kidney|cannellini|white bean|great northern bean|navy bean|refried bean' },
  chickpeas: { buy: 'Chickpeas', names: 'chickpea|chick pea|garbanzo' },
  cannedTomatoes: { buy: 'Diced tomatoes', names: 'diced tomato|crushed tomato|canned tomato|stewed tomato|whole peeled tomato|fire roasted tomato' },
  tomatoPaste: { buy: 'Tomato paste', names: 'tomato paste' },
  marinara: { buy: 'Marinara sauce', names: 'marinara|pasta sauce|spaghetti sauce|tomato sauce|pizza sauce' },
  pumpkin: { buy: 'Canned pumpkin', names: 'pumpkin', not: /spice|seed|pie|bread|latte/ },
  pasta: { buy: 'Whole-wheat pasta', names: 'spaghetti|pasta|penne|rotini|fusilli|macaroni|elbow|linguine|farfalle|bow tie|shell|ziti|rigatoni|orzo|pappardelle|fettuccine', not: /taco|squash/ },
  rice: { buy: 'Brown rice', names: 'rice', not: /krispie|cereal/ },
  tortillas: { buy: 'Whole-wheat tortillas', names: 'tortilla|wrap', not: /rice|spring roll/ },
  tacoShells: { buy: 'Taco shells', names: 'taco shell|tostada' },
  bread: { buy: 'Whole-grain bread', names: 'bread|sourdough|bagel|english muffin|naan|pita|flatbread|bun' },
  breadcrumbs: { buy: 'Panko breadcrumbs', names: 'breadcrumb|bread crumb|panko' },
  potatoes: { buy: 'Potatoes', names: 'potato', not: /sweet|instant|flake|tot/ },
  sweetPotatoes: { buy: 'Sweet potatoes', names: 'sweet potato|yam' },
  spinach: { buy: 'Baby spinach', names: 'spinach|kale|power green|baby green' },
  broccoli: { buy: 'Broccoli', names: 'broccoli|broccolini', not: /slaw/ },
  peas: { buy: 'Frozen peas', names: 'pea', not: /chick|snap|snow|split/ },
  greenBeans: { buy: 'Green beans', names: 'green bean|string bean|haricot vert' },
  corn: { buy: 'Frozen corn', names: 'corn', not: /starch|syrup|flake|dog|meal|pop|masa/ },
  peppers: { buy: 'Bell peppers', names: 'bell pepper|sweet pepper|mini pepper|red pepper|green pepper|yellow pepper|orange pepper', not: /flake|crushed|roasted/ },
  carrots: { buy: 'Carrots', names: 'carrot' },
  mixedVeg: { buy: 'Frozen mixed vegetables', names: 'mixed vegetable|mixed veg|stir fry vegetable|stir fry blend|vegetable medley|california blend|frozen vegetable' },
  onions: { buy: 'Onions', names: 'onion|shallot', not: /ring/ },
  garlic: { buy: 'Garlic', names: 'garlic', not: /salt/ },
  lemons: { buy: 'Lemons', names: 'lemon|lemon juice', not: /pepper|curd|lemonade/ },
  limes: { buy: 'Limes', names: 'lime|lime juice', not: /pickle/ },
  avocado: { buy: 'Avocados', names: 'avocado|guacamole' },
  oil: { buy: 'Olive oil', names: 'olive oil|avocado oil|vegetable oil|canola oil|cooking oil|cooking spray', not: /tomato/ },
  soySauce: { buy: 'Low-sodium soy sauce', names: 'soy sauce|tamari|coconut aminos|teriyaki|hoisin|oyster sauce|oyster flavored sauce' },
  salsa: { buy: 'Salsa', names: 'salsa' },
  tacoSpice: { buy: 'Taco seasoning', names: 'taco seasoning|taco seasoning mix|fajita seasoning|chili powder|cumin' },
  curry: { buy: 'Mild curry powder', names: 'curry|curry powder|curry paste|garam masala' },
  coconutMilk: { buy: 'Light coconut milk', names: 'coconut milk|coconut cream' },
  broth: { buy: 'Low-sodium chicken broth', names: 'broth|stock|bouillon' },
};
const FOOD_IDS = Object.keys(FOODS);

// Each ingredient: [what the recipe says, the food, how much it uses in the stock's own units
// (0: just needs some), optional]. Where other foods will do, the food is a list (first choice
// first), or { food: amount } when they come in different amounts. Optional ones (a garnish,
// something to serve alongside) don't count against a dinner and don't go on the shopping list.
const OPT = true;
export const DINNERS = [
  { id: 'spag', name: 'Turkey & spinach spaghetti', min: 25, veg: false,
    ing: [['1 box spaghetti', 'pasta', 1], ['2 cans diced tomatoes (or 3 tbsp tomato paste)', { cannedTomatoes: 2, tomatoPaste: 0.5 }], ['1 lb ground turkey or beef', 'groundMeat', 1], ['2 handfuls spinach', 'spinach', 0.5, OPT], ['2 tbsp olive oil', 'oil', 0], ['2 cloves garlic', 'garlic', 0], ['Parmesan to serve', 'parmesan', 0, OPT]],
    steps: ['Boil the spaghetti, about 10 minutes.', 'Meanwhile brown the meat with garlic in olive oil, 6 minutes.', 'Add the tomatoes (or paste and a cup of the pasta water) and simmer 8 minutes. Stir in the spinach.', 'Toss with the pasta and top with parmesan.'],
    tod: 'Break the spaghetti in half before cooking. Chop the spinach fine so it disappears into the sauce.' },
  { id: 'ques', name: 'Black bean quesadillas with buttery peas', min: 15, veg: true,
    ing: [['1 can black or refried beans', 'beans', 1], ['2 cups grated cheese', 'cheese', 0.5], ['6 tortillas', 'tortillas', 0], ['2 cups frozen peas or corn', ['peas', 'corn'], 0.5], ['A little butter', 'butter', 0, OPT], ['Salsa for the adults', 'salsa', 0, OPT]],
    steps: ['Rinse the beans and mash them roughly with a fork.', 'Spread beans and cheese on half of each tortilla and fold.', 'Cook 3 minutes per side in a dry pan until golden.', 'Microwave the peas 4 minutes with a little butter.'],
    tod: 'Cut into thin strips. Squish the peas a little for younger toddlers so they don’t roll.' },
  { id: 'rice', name: 'Veggie egg fried rice', min: 25, veg: true,
    ing: [['1½ cups rice', 'rice', 0.3], ['5 eggs', 'eggs', 5], ['2 cups peas or mixed veg', ['peas', 'mixedVeg'], 0.5], ['2 carrots, diced', 'carrots', 0, OPT], ['Low-sodium soy sauce', 'soySauce', 0], ['1 tbsp oil', 'oil', 0]],
    steps: ['Cook the rice (or use leftover rice and skip to step 2).', 'Scramble the eggs in oil, then set aside.', 'Stir-fry the vegetables 4 minutes, add the rice and fry 3 more.', 'Fold in the eggs and a splash of soy sauce.'],
    tod: 'Cook the eggs fully. Add just a splash of soy sauce and season the adult plates more.' },
  { id: 'frit', name: 'Spinach & cheddar frittata with toast', min: 20, veg: true,
    ing: [['8 eggs', 'eggs', 8], ['½ cup milk', 'milk', 0.04], ['2 handfuls spinach or chopped broccoli', ['spinach', 'broccoli'], 0.5], ['1 cup grated cheese', 'cheese', 0.25], ['Toast to serve', 'bread', 0, OPT], ['1 tbsp oil', 'oil', 0]],
    steps: ['Heat the oven to 400°F (200°C).', 'Whisk the eggs and milk; soften the greens in an oven-safe pan with oil.', 'Pour in the eggs, scatter the cheese and cook 3 minutes on the stove.', 'Bake 10–12 minutes until set. Serve with toast.'],
    tod: 'Cut into fingers they can hold. Check the center is fully set.' },
  { id: 'bowl', name: 'Chicken burrito bowls', min: 25, veg: false,
    ing: [['1 cup rice', 'rice', 0.2], ['1 can black beans', 'beans', 1], ['1 lb chicken (or 2 cans chunk chicken)', 'chicken', 1], ['1 cup corn', 'corn', 0, OPT], ['1 avocado', 'avocado', 0, OPT], ['Grated cheese', 'cheese', 0.15], ['Mild taco seasoning', 'tacoSpice', 0]],
    steps: ['Start the rice.', 'Dice the chicken, toss with taco seasoning and pan-fry 8 minutes (canned chicken just needs warming through).', 'Warm the beans and corn together.', 'Build bowls with rice, chicken, beans, corn, cheese and avocado.'],
    tod: 'Dice the chicken small and lightly mash the beans. Avocado slices make an easy finger food.' },
  { id: 'salm', name: 'Baked salmon with rice & peas', min: 20, veg: false,
    ing: [['1¼ lb salmon or white fish', ['salmon', 'whiteFish'], 1], ['1 cup rice', 'rice', 0.2], ['2 cups peas, green beans or broccoli', ['peas', 'greenBeans', 'broccoli'], 0.5], ['1 lemon', 'lemons', 0, OPT], ['1 tbsp olive oil', 'oil', 0]],
    steps: ['Heat the oven to 425°F (220°C) and start the rice.', 'Brush the fish with oil and bake 12–14 minutes.', 'Steam or microwave the vegetables for the last 5 minutes.', 'Squeeze lemon over the adult portions.'],
    tod: 'Flake the fish and check carefully for bones before serving.' },
  { id: 'soup', name: 'Tomato soup & grilled cheese', min: 20, veg: true,
    ing: [['2 cans diced tomatoes', 'cannedTomatoes', 2], ['1 cup milk', 'milk', 0.06], ['8 slices whole-grain bread', 'bread', 0], ['Sliced or grated cheese', 'cheese', 0.3], ['½ onion', 'onions', 0], ['Butter for the bread', 'butter', 0, OPT]],
    steps: ['Soften the onion in a little butter, 4 minutes.', 'Add the tomatoes, simmer 8 minutes, then blend until smooth and stir in the milk.', 'Meanwhile make grilled cheese sandwiches, 3 minutes per side.'],
    tod: 'Cool the soup to lukewarm and cut sandwiches into strips for dipping.' },
  { id: 'eggs', name: 'Eggs baked in tomato sauce', min: 20, veg: true,
    ing: [['6 eggs', 'eggs', 6], ['2 cans diced tomatoes', 'cannedTomatoes', 2], ['2 handfuls spinach', 'spinach', 0.5, OPT], ['1 tbsp olive oil', 'oil', 0], ['Toast for dipping', 'bread', 0, OPT]],
    steps: ['Simmer the tomatoes with oil for 6 minutes. Stir in the spinach.', 'Make 6 wells and crack in the eggs.', 'Cover and cook 6–8 minutes. Serve with toast for dipping.'],
    tod: 'Cook the toddler eggs until the yolks are firm, not runny.' },
  { id: 'chil', name: 'Mild turkey & bean chili', min: 30, veg: false,
    ing: [['1 lb ground turkey or beef', 'groundMeat', 1], ['2 cans beans (any kind)', 'beans', 2], ['1 can diced tomatoes (or 2 tbsp tomato paste)', { cannedTomatoes: 1, tomatoPaste: 0.5 }], ['1 cup rice', 'rice', 0.2], ['Grated cheese', 'cheese', 0.15, OPT], ['1 onion', 'onions', 0], ['Mild chili powder or taco seasoning', 'tacoSpice', 0]],
    steps: ['Start the rice.', 'Brown the meat and onion, 7 minutes.', 'Add beans, tomatoes, seasoning and a cup of water; simmer 15 minutes.', 'Serve over rice with cheese.'],
    tod: 'Keep it mild and add hot sauce to adult bowls. Stirring in cheese cools it down faster.' },
  { id: 'past', name: 'Creamy chicken & pea pasta', min: 25, veg: false,
    ing: [['1 box pasta', 'pasta', 1], ['1 lb chicken (or 2 cans chunk chicken)', 'chicken', 1], ['2 cups peas or broccoli', ['peas', 'broccoli', 'mixedVeg'], 0.5], ['1 cup milk', 'milk', 0.06], ['1 cup grated cheese', 'cheese', 0.25], ['1 tbsp olive oil', 'oil', 0]],
    steps: ['Boil the pasta, adding the vegetables for the last 3 minutes.', 'Pan-fry diced chicken in oil, 8 minutes (canned chicken just needs warming).', 'Drain the pasta, return to the pot with milk and cheese and stir until creamy.', 'Fold in the chicken.'],
    tod: 'Cut the pasta short and the chicken into pea-sized pieces.' },
  { id: 'taco', name: 'Sweet potato & black bean tacos', min: 25, veg: true,
    ing: [['2 sweet potatoes', 'sweetPotatoes', 0], ['1 can black beans', 'beans', 1], ['8 small tortillas or taco shells', ['tortillas', 'tacoShells'], 0], ['Grated cheese', 'cheese', 0.15], ['Plain Greek yogurt', 'yogurt', 0, OPT], ['1 lime', 'limes', 0, OPT]],
    steps: ['Dice the sweet potatoes, microwave 6 minutes, then crisp in a pan with cumin.', 'Warm the beans and tortillas.', 'Fill the tacos and top with cheese, yogurt and lime.'],
    tod: 'Serve it deconstructed: soft sweet potato cubes, mashed beans and cheese in separate piles.' },
  { id: 'beef', name: 'Beef & broccoli rice bowls', min: 20, veg: false,
    ing: [['1 lb ground beef or turkey', 'groundMeat', 1], ['1 head broccoli or a bag of frozen', ['broccoli', 'mixedVeg'], 0.5], ['1 cup rice', 'rice', 0.2], ['Low-sodium soy sauce', 'soySauce', 0], ['2 cloves garlic', 'garlic', 0]],
    steps: ['Start the rice.', 'Brown the meat with garlic, 6 minutes.', 'Add the broccoli and a splash of water, cover and steam 5 minutes.', 'Season with soy sauce and serve over rice.'],
    tod: 'Cut the broccoli into tiny trees and cook it a little longer for them.' },
  { id: 'faji', name: 'Sheet-pan chicken fajitas', min: 25, veg: false,
    ing: [['1 lb chicken or shrimp', ['chicken', 'shrimp'], 1], ['3 bell peppers', 'peppers', 0], ['1 onion', 'onions', 0], ['8 tortillas', 'tortillas', 0], ['Grated cheese', 'cheese', 0.15, OPT], ['Greek yogurt or sour cream', 'yogurt', 0, OPT], ['Fajita or taco seasoning', 'tacoSpice', 0]],
    steps: ['Heat the oven to 425°F (220°C).', 'Slice chicken, peppers and onion thin; toss with oil and seasoning on a sheet pan.', 'Roast 15–18 minutes.', 'Serve in warm tortillas with cheese and yogurt.'],
    tod: 'Leave a corner of the pan unseasoned for them, and cut everything into thin, soft strips.' },
  { id: 'shri', name: 'Lemon garlic shrimp pasta', min: 20, veg: false,
    ing: [['1 lb shrimp', 'shrimp', 1], ['1 box pasta', 'pasta', 1], ['3 cloves garlic', 'garlic', 0], ['1 lemon', 'lemons', 0], ['2 handfuls spinach', 'spinach', 0.5, OPT], ['Parmesan', 'parmesan', 0, OPT], ['2 tbsp butter or olive oil', ['butter', 'oil'], 0]],
    steps: ['Boil the pasta, about 10 minutes.', 'Melt the butter with garlic, add the shrimp and cook 3–4 minutes until pink.', 'Toss in the pasta and spinach with lemon juice and parmesan.'],
    tod: 'Chop the shrimp into small pieces. Keep any chili flakes for the adults.' },
  { id: 'curr', name: 'Chickpea & spinach coconut curry', min: 20, veg: true,
    ing: [['2 cans chickpeas', 'chickpeas', 2], ['1 can light coconut milk or cream', 'coconutMilk', 1], ['2 tsp mild curry powder', 'curry', 0], ['2 handfuls spinach', 'spinach', 0.5, OPT], ['1 cup rice', 'rice', 0.2], ['1 onion', 'onions', 0]],
    steps: ['Start the rice.', 'Soften the onion, stir in the curry powder for 30 seconds.', 'Add chickpeas and coconut milk (thin coconut cream with a little water), simmer 10 minutes. Stir in the spinach.'],
    tod: 'Use a mild curry powder, or set theirs aside before adding a hot one, and mash some chickpeas.' },
  { id: 'meat', name: 'Mini meatballs with marinara', min: 30, veg: false,
    ing: [['1 lb ground turkey or beef', 'groundMeat', 1], ['1 egg', 'eggs', 1], ['½ cup breadcrumbs', 'breadcrumbs', 0], ['1 jar marinara (or tomato paste and water)', { marinara: 1, tomatoPaste: 1 }], ['1 box pasta', 'pasta', 1], ['Parmesan', 'parmesan', 0, OPT]],
    steps: ['Heat the oven to 425°F (220°C) and put the pasta water on.', 'Mix meat, egg, breadcrumbs and a little parmesan; roll into small balls.', 'Bake 12–15 minutes, then simmer in the warm sauce.', 'Serve over the pasta.'],
    tod: 'Roll some extra-small meatballs for them and cut them in quarters.' },
  { id: 'macc', name: 'Broccoli mac & cheese', min: 20, veg: true,
    ing: [['1 box short pasta', 'pasta', 1], ['1½ cups milk', 'milk', 0.1], ['2 cups grated cheddar', 'cheese', 0.5], ['1 head broccoli or 2 cups peas', ['broccoli', 'peas'], 0.5], ['2 tbsp butter', 'butter', 0]],
    steps: ['Boil the pasta, adding the broccoli for the last 4 minutes.', 'Drain, return to the pot with butter and milk over low heat.', 'Stir in the cheese until smooth and creamy.'],
    tod: 'A favorite as is. Chop the broccoli small so it gets eaten with the pasta.' },
  { id: 'spud', name: 'Loaded baked potatoes with broccoli', min: 20, veg: true,
    ing: [['4 potatoes', 'potatoes', 0], ['1 head broccoli or green beans', ['broccoli', 'greenBeans'], 0.5], ['1 cup grated cheese', 'cheese', 0.25], ['1 can beans', 'beans', 1], ['Greek yogurt or sour cream', 'yogurt', 0, OPT], ['A little butter', 'butter', 0, OPT]],
    steps: ['Prick the potatoes and microwave 8–10 minutes, turning once.', 'Steam the broccoli and warm the beans.', 'Split the potatoes and top with butter, broccoli, beans, cheese and yogurt.'],
    tod: 'Scoop out their potato, mash it with butter and cheese, and let it cool.' },
  { id: 'pizz', name: 'Veggie pita pizzas', min: 15, veg: true,
    ing: [['4 pitas, naan or tortillas', ['bread', 'tortillas'], 0], ['½ jar marinara (or tomato paste)', { marinara: 0.5, tomatoPaste: 0.5 }], ['1½ cups shredded cheese', 'cheese', 0.4], ['1 bell pepper', 'peppers', 0, OPT], ['1 handful spinach', 'spinach', 0.25, OPT]],
    steps: ['Heat the oven to 425°F (220°C).', 'Spread sauce on the pitas, top with chopped vegetables and cheese.', 'Bake 8–10 minutes until bubbling.'],
    tod: 'Chop their toppings tiny and cut the pizza into strips once it has cooled.' },
  { id: 'fish', name: 'Crispy lemon fish with green beans', min: 20, veg: false,
    ing: [['1¼ lb cod, tilapia or salmon', ['whiteFish', 'salmon'], 1], ['½ cup panko', 'breadcrumbs', 0], ['1 lb green beans or broccoli', ['greenBeans', 'broccoli'], 0.5], ['1 lemon', 'lemons', 0, OPT], ['2 tbsp olive oil', 'oil', 0], ['4 potatoes or 1 cup rice', { potatoes: 0, rice: 0.2 }]],
    steps: ['Heat the oven to 425°F (220°C). Microwave the potatoes (or start the rice).', 'Brush the fish with oil, press on the panko and bake 12 minutes.', 'Roast the green beans on the same pan.', 'Finish with lemon.'],
    tod: 'Flake the fish and check for bones. Green beans make good finger food when soft.' },
  { id: 'nood', name: 'Quick chicken noodle soup', min: 25, veg: false,
    ing: [['2 cans chunk chicken or 2 cups cooked chicken', 'chicken', 1], ['6 cups low-sodium broth', 'broth', 1], ['2 carrots', 'carrots', 0], ['1 cup small pasta', 'pasta', 0.5], ['1 onion', 'onions', 0], ['1 cup peas', 'peas', 0.25, OPT]],
    steps: ['Soften the onion and sliced carrots in a pot, 5 minutes.', 'Add the broth and bring to a boil; add the pasta and cook 8 minutes.', 'Stir in the chicken and peas for the last 3 minutes.'],
    tod: 'Use the smallest pasta you have and let their bowl cool well.' },
  { id: 'stir', name: 'Chicken & veggie stir-fry', min: 20, veg: false,
    ing: [['1 lb chicken', 'chicken', 1], ['4 cups stir-fry vegetables', ['mixedVeg', 'broccoli', 'peppers'], 0.5], ['1 cup rice', 'rice', 0.2], ['Low-sodium soy, hoisin or oyster sauce', 'soySauce', 0], ['2 cloves garlic', 'garlic', 0], ['1 tbsp oil', 'oil', 0]],
    steps: ['Start the rice.', 'Sear thin strips of chicken in hot oil, 6 minutes.', 'Add garlic and vegetables, stir-fry 5 minutes.', 'Splash in the sauce and serve over rice.'],
    tod: 'Cut their chicken small and cook their vegetables a minute longer.' },
  { id: 'burg', name: 'Mini turkey burgers with sweet potato wedges', min: 30, veg: false,
    ing: [['1 lb ground turkey or beef', 'groundMeat', 1], ['2 sweet potatoes or 3 potatoes', ['sweetPotatoes', 'potatoes'], 0], ['Small buns or bread', 'bread', 0], ['Sliced cheese', 'cheese', 0.15, OPT], ['1 avocado', 'avocado', 0, OPT], ['1 tbsp olive oil', 'oil', 0]],
    steps: ['Heat the oven to 425°F (220°C). Cut the potatoes into wedges, toss with oil and roast 25 minutes.', 'Shape the meat into small patties and pan-fry 4 minutes per side.', 'Serve on buns with cheese and avocado.'],
    tod: 'Make tiny patties, cut them in quarters, and serve the wedges soft.' },
  { id: 'wrap', name: 'Scrambled egg & veggie wraps', min: 15, veg: true,
    ing: [['8 eggs', 'eggs', 8], ['4 tortillas', 'tortillas', 0], ['1 cup grated cheese', 'cheese', 0.25], ['1 bell pepper or 2 handfuls spinach', ['peppers', 'spinach'], 0.25], ['Salsa', 'salsa', 0, OPT], ['1 avocado', 'avocado', 0, OPT]],
    steps: ['Soften the chopped pepper or spinach in a pan, 3 minutes.', 'Add the beaten eggs and scramble gently with the cheese.', 'Wrap in warm tortillas with salsa and avocado.'],
    tod: 'Cook their eggs fully and serve the wrap cut into small rounds.' },
  { id: 'fagi', name: 'Pasta e fagioli (bean & pasta soup)', min: 25, veg: true,
    ing: [['1 can white, kidney or black beans', 'beans', 1], ['1 cup small pasta (macaroni, orzo)', 'pasta', 0.5], ['4 cups vegetable or chicken broth', 'broth', 1], ['1 can diced tomatoes or 2 tbsp tomato paste', { cannedTomatoes: 1, tomatoPaste: 0.5 }], ['1 onion', 'onions', 0], ['2 cloves garlic', 'garlic', 0], ['1 carrot', 'carrots', 0, OPT], ['Parmesan', 'parmesan', 0, OPT]],
    steps: ['Soften the chopped onion, garlic and carrot in a little oil, 5 minutes.', 'Stir in the tomatoes or paste, then the broth and beans; bring to a boil.', 'Add the pasta and simmer 9 minutes. Top with parmesan.'],
    tod: 'Mash some of the beans into the soup to thicken it, and let their bowl cool.' },
  { id: 'tuna', name: 'Tuna & potato cakes with peas', min: 25, veg: false,
    ing: [['2 cans tuna', 'tuna', 2], ['2 potatoes', 'potatoes', 0], ['1 egg', 'eggs', 1], ['½ cup panko', 'breadcrumbs', 0], ['2 cups peas, green beans or broccoli', ['peas', 'greenBeans', 'broccoli'], 0.5], ['1 lemon', 'lemons', 0, OPT], ['2 tbsp oil', 'oil', 0]],
    steps: ['Dice the potatoes, microwave 6–7 minutes until soft, then mash.', 'Mix in the drained tuna, the egg and half the panko; shape 8 small cakes and coat in the rest.', 'Pan-fry in oil 3 minutes per side. Steam the peas alongside.'],
    tod: 'Great finger food. For little ones, canned light tuna is the everyday pick; yellowfin is fine about once a week.' },
  { id: 'tacn', name: 'Chicken & bean taco night', min: 15, veg: false,
    ing: [['2 cans chunk chicken or 1 lb cooked chicken', 'chicken', 1], ['1 can refried or black beans', 'beans', 1], ['Taco shells or tortillas', ['tacoShells', 'tortillas'], 0], ['Taco seasoning', 'tacoSpice', 0], ['Grated cheese', 'cheese', 0.2], ['Salsa', 'salsa', 0, OPT], ['1 avocado', 'avocado', 0, OPT]],
    steps: ['Warm the chicken in a pan with taco seasoning and a splash of water, 4 minutes.', 'Warm the beans and the shells.', 'Fill the tacos with beans, chicken and cheese; add salsa and avocado.'],
    tod: 'Crunchy shells shatter: crumble theirs into a bowl with the fillings as a taco bowl.' },
  { id: 'posu', name: 'Creamy potato & onion soup', min: 30, veg: true,
    ing: [['2 lb potatoes', 'potatoes', 0], ['1 onion', 'onions', 0], ['4 cups broth', 'broth', 1], ['1 cup milk', 'milk', 0.06], ['Grated cheese to top', 'cheese', 0.15, OPT], ['1 tbsp butter or oil', ['butter', 'oil'], 0]],
    steps: ['Soften the chopped onion in butter, 5 minutes.', 'Add diced potatoes and broth; simmer 15 minutes until soft.', 'Mash or blend until creamy, stir in the milk, and top with cheese.'],
    tod: 'Let it cool and serve thick, with toast fingers for dipping.' },
  { id: 'pump', name: 'Creamy pumpkin pasta', min: 20, veg: true,
    ing: [['1 box pasta', 'pasta', 1], ['1 can pumpkin', 'pumpkin', 1], ['½ cup milk or broth', ['milk', 'broth'], 0.04], ['Parmesan', 'parmesan', 0], ['2 cloves garlic', 'garlic', 0], ['2 handfuls spinach', 'spinach', 0.5, OPT]],
    steps: ['Boil the pasta, about 10 minutes.', 'Warm the garlic in a little oil, then stir in the pumpkin and milk until smooth.', 'Toss with the pasta, spinach and parmesan, loosening with pasta water.'],
    tod: 'Naturally sweet and mild. Cut long pasta short for them.' },
  { id: 'bnrc', name: 'Cheesy bean & rice skillet', min: 20, veg: true,
    ing: [['1 cup rice', 'rice', 0.2], ['2 cans beans', 'beans', 2], ['1 can diced tomatoes or salsa', ['cannedTomatoes', 'salsa'], 1], ['Taco seasoning', 'tacoSpice', 0], ['1 cup grated cheese', 'cheese', 0.25], ['1 cup corn', 'corn', 0, OPT]],
    steps: ['Cook the rice.', 'Warm the beans, tomatoes, corn and seasoning in a skillet, 5 minutes.', 'Stir in the rice, top with cheese and cover until melted.'],
    tod: 'Mash the beans a little and let it cool. Keep the seasoning light.' },
];
export const dinnerById = Object.fromEntries(DINNERS.map((r) => [r.id, r]));
export const PLAN_DAYS = 7;

// Words that, coming after a food's name, make it something else: chicken broth, garlic powder,
// rice vinegar, corn tortillas, shrimp creole mix. Not when the food itself goes by that name
// (soy sauce, pasta sauce, taco seasoning mix).
const AFTER = /\b(broth|stock|bouillon|soup|seasoning|sauce|powder|paste|vinegar|flour|chips?|crackers?|bars?|juice|chocolate|dressing|dip|mix|noodles?|nuggets?|tortillas?|wraps?|bread|naan|crumbs?|cakes?|pudding|cereal|snacks?|puffs|pouch(es)?|bites|sticks?|string|oil|fries|sausages?|hot dogs?|patt(y|ies)|meatballs?|wings?|burgers?|salad|spread|jerky|pie|muffins?|cookies?|crisps|rings?|pasta|ravioli|tortellini|pizza|lasagna|dumplings?|burritos?|enchiladas?|bowls?|meals?|entrees?)\b/g;
const patterns = new Map();
const pattern = (food) => {
  if (!patterns.has(food)) patterns.set(food, new RegExp(`\\b(?:${FOODS[food].names})(?:s|es)?\\b`));
  return patterns.get(food);
};
const plain = (name) => name.toLowerCase().replace(/[-_/&,]+/g, ' ');

// Whether something in stock is this food.
export function matches(name, food) {
  const f = FOODS[food];
  const n = plain(name);
  const m = pattern(food).exec(n);
  if (!m || f.not?.test(n)) return false;
  const after = n.slice(m.index + m[0].length).match(AFTER) || [];
  return after.every((w) => f.names.includes(w) || f.names.includes(w.replace(/e?s$/, '')));
}

export const shopName = (food) => FOODS[food].buy;

export function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Recipes allowed by the filters: { max } minutes, { veg } meatless only.
export const dinnerPool = ({ max = 30, veg = false } = {}) => DINNERS.filter((r) => r.min <= max && (!veg || r.veg)).map((r) => r.id);

// Past its use-by date by night `day` of the plan (0 is tonight).
const expired = (s, day = 0) => s.days != null && s.days < day;
// Which stock entries are each food, worked out once per stock list.
const hitCache = new WeakMap();
function hits(stock, food) {
  let m = hitCache.get(stock);
  if (!m) hitCache.set(stock, (m = new Map()));
  if (!m.has(food)) m.set(food, stock.filter((s) => matches(s.name, food)));
  return m.get(food);
}

// How much there is, in the recipes' units. Eggs kept by the carton count as 12 each; with no
// unit, 3 or fewer are taken as cartons too (nobody keeps count of 2 loose eggs). Canned chicken
// counts by the can.
const PACKS = /carton|dozen|pack|box|case|flat|tray|\bct\b/i;
const CANNED = /\b(canned|chunk)\b/;
function amount(stock, s) {
  const qty = Math.max(0, Number(s.qty) || 0);
  for (const f of FOOD_IDS) {
    const { pack, canned } = FOODS[f];
    if (!(pack || canned) || !hits(stock, f).includes(s)) continue;
    if (pack && (PACKS.test(s.unit || '') || (!s.unit && qty <= 3))) return qty * pack;
    if (canned && (CANNED.test(plain(s.name)) || /^can/.test(s.unit || ''))) return qty * canned;
  }
  return qty;
}
const fresh = (stock) => new Map(stock.map((s) => [s, expired(s) ? 0 : amount(stock, s)]));

// An ingredient's choices as [[food, amount], …], first choice first.
const choices = (foods, use) => (typeof foods === 'string' ? [[foods, use]] : Array.isArray(foods) ? foods.map((f) => [f, use]) : Object.entries(foods));

// Night `day`'s dinner drawn from what's left, which it updates. Only food still good that night
// counts. `short`: there's some, but not as much as the recipe uses. `stale`: there is some, but
// it'll be past its use-by date by then.
function take(stock, left, id, day) {
  return dinnerById[id].ing.map(([label, foods, use = 0, opt = false]) => {
    const opts = choices(foods, use);
    let item = null;
    let some = null;
    for (const [f, n] of opts) {
      const usable = hits(stock, f).filter((s) => !expired(s, day) && left.get(s) > 0);
      item = usable.find((s) => left.get(s) >= n - 1e-9) || null;
      if (item) {
        left.set(item, left.get(item) - n);
        break;
      }
      some ||= usable[0] || null;
    }
    if (!item && some) left.set(some, 0);
    const stale = !item && !some && opts.some(([f]) => hits(stock, f).some((s) => s.qty > 0 && expired(s, day)));
    return { label, food: opts[0][0], item: item || some, short: !item && Boolean(some), stale, opt };
  });
}

// The plan in order, each dinner using what the ones before it left.
export function allocate(ids, stock) {
  const left = fresh(stock);
  return ids.map((id, day) => take(stock, left, id, day));
}

// The ingredients a dinner can't do without, and how many of those are in stock in full.
export const needed = (rows) => rows.filter((x) => !x.opt);
export const inStock = (rows) => needed(rows).filter((x) => x.item && !x.short).length;

// Days from night `day` until the item's use-by date, when that's 3 or fewer; otherwise null.
export const goingOff = (item, day) => (item?.days != null && item.days - day <= 3 ? item.days - day : null);

// The best dinner for night `day`: most of what it needs in stock, extra credit for using food
// that's about to go.
function pick(stock, left, cands, day, rand) {
  let best = null;
  let top = -Infinity;
  for (const id of cands) {
    const rows = take(stock, new Map(left), id, day);
    const must = needed(rows);
    const have = must.reduce((n, x) => n + (x.item ? (x.short ? 0.5 : 1) : 0), 0);
    let score = (have / must.length) * 10 - dinnerById[id].min / 30 + (rand ? rand() * 2.5 : 0);
    for (const { item, short } of rows) if (!short && goingOff(item, day) != null) score += (4 - goingOff(item, day)) * 1.5;
    if (score > top) [best, top] = [id, score];
  }
  return best;
}

// Plans the week night by night. `fixed` holds a dinner to keep for each night, or null to
// choose one; nothing repeats unless the filters leave too few to choose from.
export function planWeek(fixed, stock, filters, rand) {
  const all = dinnerPool(filters);
  const out = [];
  const left = fresh(stock);
  for (let day = 0; day < PLAN_DAYS; day++) {
    let id = fixed[day];
    if (!id) {
      const taken = [...out, ...fixed.slice(day + 1).filter(Boolean)];
      let cands = all.filter((x) => !taken.includes(x));
      if (!cands.length) cands = all.filter((x) => x !== out.at(-1) && x !== fixed[day + 1]);
      if (!cands.length) cands = all;
      if (!cands.length) break;
      id = pick(stock, left, cands, day, rand);
    }
    take(stock, left, id, day);
    out.push(id);
  }
  return out;
}

// Keeps the dinners already planned and fills the rest of the week after them.
export const extendPlan = (ids, stock, filters, rand) => planWeek(Array.from({ length: PLAN_DAYS }, (_, i) => ids[i] || null), stock, filters, rand);

// Another dinner for night `d`, one not already in the plan or shown there before (`seen`, which
// starts over once every choice has had a turn). Null when there's nothing else to offer.
export function swapDinner(ids, d, stock, filters, seen) {
  const free = dinnerPool(filters).filter((id) => !ids.includes(id));
  seen.add(ids[d]);
  let cands = free.filter((id) => !seen.has(id));
  if (!cands.length) {
    seen.clear();
    seen.add(ids[d]);
    cands = free;
  }
  if (!cands.length) return null;
  const left = fresh(stock);
  ids.slice(0, d).forEach((id, day) => take(stock, left, id, day));
  const id = pick(stock, left, cands, d);
  seen.add(id);
  return id;
}

// A short fingerprint of the food in stock, to tell when it has changed since the plan was made.
export function stockKey(stock) {
  const s = stock.filter((x) => FOOD_IDS.some((f) => hits(stock, f).includes(x))).map((x) => `${x.name}:${x.qty}:${x.unit || ''}`).sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
