// Exercise the presented picker while preserving native select fallback coverage.
export async function selectControl(locator, value) {
  const trigger=locator.locator('..').locator(':scope > .property-trigger');
  if(!await trigger.count() || !await trigger.isVisible())return locator.selectOption(value);
  if(Array.isArray(value))throw new Error('An enhanced single property cannot select multiple options');
  const option=await locator.evaluate((select,requested)=>{
    const index=[...select.options].findIndex((item,index)=>typeof requested==='string'?item.value===requested:requested.value!==undefined?item.value===requested.value:requested.label!==undefined?item.label===requested.label:index===requested.index);
    if(index<0)return null;return {label:select.options[index].label,value:select.options[index].value};
  },value);
  if(!option)throw new Error('Requested property option is unavailable');
  await trigger.click();
  const menu=locator.page().locator(`#${await trigger.getAttribute('aria-controls')}`);
  await menu.getByRole('option',{name:option.label,exact:true}).click();
  return [option.value];
}
